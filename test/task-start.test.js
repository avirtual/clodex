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

const { createSessionManager, ticketCloseLine } = require('../session-manager');
const { mkTmpRoot } = require('./lib/tmp-roots');
// t353: the dispatch head carries the close verb. Imported, not copied — the
// pins in this file are ENTER/setup assertions about WHICH delivery happened,
// not about the verb's wording. The wording is pinned once in
// session-manager.test.js (a deliberate copy) and against the tickets-viewer
// duplicate in tickets-viewer-path-parity.test.js; a third hand-copy here would
// just be a third place to forget.
const specBody = (id, spec) => `[ticket ${id}] ${ticketCloseLine(id)}${spec}`;
const ticketsMod = require('../tickets-store');
const { intentEnabled } = require('../intent-catalog');
const { parseIntent } = require('../intent-scanner');

function mkStart(extra = {}) {
  const home = mkTmpRoot('clodex-ts-');
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
  // t431: dispatch refuses a ticket whose spec names no `tasks/…` path. The specs
  // in this file are about the dispatch VERB, not artifact resolution, so the
  // precondition is supplied here — on the RECORD, never appended to the spec,
  // because many assertions below pin the delivered body byte-for-byte through
  // `specBody`.
  //
  // Opt-out rather than unconditional: the gate's OWN tests need a ticket that
  // genuinely lacks a task dir, and a fixture that silently made that state
  // unreachable would leave them asserting against a case they never built.
  const state = { autoTaskDir: true };
  const handleTask = m._handleTask.bind(m);
  m._handleTask = (session, intent) => {
    const isAdd = state.autoTaskDir && intent && intent.type === 'task' && intent.sub === 'add';
    const before = isAdd ? new Set(tstore.load(team.root).map((t) => t.id)) : null;
    const r = handleTask(session, intent);
    if (isAdd) {
      const ts = tstore.load(team.root);
      let touched = false;
      // Only the ids this `add` INTRODUCED. Stamping every task-dir-less ticket on
      // the board would resurrect state a test deliberately built: strip `taskDir`
      // from t1, file t2, and the loop silently puts t1's back.
      for (const t of ts) {
        if (!before.has(t.id) && !t.taskDir) { t.taskDir = `tasks/${t.id}-fixture/SPEC.md`; touched = true; }
      }
      if (touched) tstore.save(team.root, ts);
    }
    return r;
  };
  return {
    m, team, home, tstore, injected, gated, urgents, broadcasts, seat, state,
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
    { type: 'task', sub: 'start', id: 't7', who: null, reviewer: null, body: '' });
  // Trailing prose is DISCARDED, not captured: start takes no body, and text
  // after the bracket is the lead thinking out loud.
  assert.deepStrictEqual(parseIntent('[agent:task start t7] go on then'),
    { type: 'task', sub: 'start', id: 't7', who: null, reviewer: null, body: '' });
  assert.deepStrictEqual(parseIntent('[agent:task start]'),
    { type: 'task', sub: 'start', id: null, who: null, reviewer: null, body: '' });
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
  assert.deepStrictEqual(f.gated, [{ target: 'team-hand', sender: 'lead', body: specBody('t1', 'build the widget\ndetail') }]);
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
  assert.deepStrictEqual(f.gated, [{ target: 'team-hand', sender: 'lead', body: specBody('t1', 'name-addressed work') }],
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

// ── startedAt: the recorded fact, and the records that predate it ───────────
// Started-ness began as an INFERENCE — `role` set and pinned to a live seat —
// and that reading was wrong for the shapes that do not re-pin. It is a field
// now because the loop steps downstream key off it, and a derived signal that
// is correct today goes silently wrong the first time a non-worktree role needs
// the same distinction.

test('startedAt: add writes the key holding null, and start stamps it', () => {
  const f = mkStart();
  f.seat('lead'); f.seat('team-hand');
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'the spec' });
  const added = f.one('t1');
  // The KEY's presence is what tells a new unstarted ticket from a pre-upgrade
  // record, so its absence is a different state and this cannot be an
  // `== null` check. `hasOwnProperty` on the reloaded record, not on the object
  // add built: the round trip through JSON is where an undefined would vanish.
  assert.ok(Object.prototype.hasOwnProperty.call(added, 'startedAt'),
    'the key is WRITTEN, not omitted — an absent key reads as a legacy dispatched ticket, which would file every new ticket as already started');
  assert.strictEqual(added.startedAt, null, 'and it holds null until something starts it');

  const before = Date.now();
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'start', who: null, id: 't1', body: '' });
  const started = f.one('t1');
  assert.ok(typeof started.startedAt === 'number' && started.startedAt >= before,
    'start stamps it with the moment of dispatch');
});

test('startedAt: assign stamps a ticket it dispatches, and never restates the first start', () => {
  const f = mkStart();
  opened(f);
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'start', who: null, id: 't1', body: '' });
  const first = f.one('t1').startedAt;
  assert.ok(first != null, 'ENTER: started, or the re-send below cannot restate anything');
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'assign', id: 't1', who: 'hand', body: '' });
  assert.strictEqual(f.one('t1').startedAt, first,
    'a re-send must not move the stamp — it marks when work FIRST started, which is what the later loop steps measure from');
});

test('startedAt: assign is the OTHER dispatch path, so it stamps an unstarted ticket', () => {
  const f = mkStart();
  f.seat('lead'); f.seat('team-hand');
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'the spec' });
  assert.strictEqual(f.one('t1').startedAt, null, 'ENTER: unstarted after add');
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'assign', id: 't1', who: 'hand', body: '' });
  assert.ok(f.one('t1').startedAt != null,
    'assign dispatched it, so it is started — leaving it unstamped keeps it startable, and starting it mints a second seat onto the tree assign just sent a hand into');
  f.gated.length = 0;
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'start', who: null, id: 't1', body: '' });
  assert.deepStrictEqual(f.gated, [], 'and start now refuses it');
  assert.match(f.notes(), /already started/);
});

// The upgrade hazard. Every ticket in a live tickets.json was dispatched by the
// OLD `add` and carries no `startedAt` at all. Reading those as never-started
// drops them out of _openTicketsFor, so replay and _advanceSeat stop seeing real
// in-flight work on the first launch after upgrade — strictly worse than the
// tree collision this field fixes. The fixture is written STRAIGHT TO THE STORE
// in the pre-t308 shape rather than built by `add`, because `add` cannot produce
// it any more: that is the whole point.
test('startedAt: a pre-upgrade record with NO startedAt key is read as started', () => {
  const f = mkStart();
  f.seat('lead'); f.seat('team-hand');
  const now = Date.now();
  f.tstore.save(f.team.root, [{
    id: 't1', title: 'legacy work', spec: 'legacy work\ndetail',
    assignee: 'team-hand', role: 'hand', opener: 'lead', state: 'open',
    openedAt: now - 90000, closedAt: null, lastActivityAt: now - 90000, nudgedAt: null,
  }]);
  const legacy = f.one('t1');
  // ENTER: the fixture must really be old-format. A `startedAt: null` slipping
  // in — from a helper, or from a store that fills defaults — would make this
  // test assert the NEW path while claiming to cover the old one.
  assert.ok(!Object.prototype.hasOwnProperty.call(legacy, 'startedAt'),
    'ENTER: the record carries no startedAt key at all, which is the shape under test');

  assert.deepStrictEqual(f.m._openTicketsFor(f.team, 'team-hand').map((t) => t.id), ['t1'],
    'it stays in the queue — dropping it here is what makes replay and advance lose in-flight work across an upgrade');
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'start', who: null, id: 't1', body: '' });
  assert.deepStrictEqual(f.gated, [],
    'and it is not startable a second time — it was already dispatched, by the code that had no field to say so');
  assert.match(f.notes(), /already started/);
});

// The one legacy shape that provably never dispatched: the old `add` returned
// before delivering when parked. Without this arm the documented
// park-then-release flow would refuse to start on the first post-upgrade launch.
test('startedAt: a pre-upgrade PARKED record is read as never started, so it can still be started', () => {
  const f = mkStart();
  f.seat('lead'); f.seat('team-hand');
  const now = Date.now();
  f.tstore.save(f.team.root, [{
    id: 't1', title: 'filed for later', spec: 'filed for later\ndetail',
    // A dispatchable ticket carries one (t431 refuses one without at start), and
    // this record is genuinely never-started, so the gate applies to it. Its
    // subject is how a pre-upgrade record READS, not artifact resolution.
    taskDir: 'tasks/filed-for-later/SPEC.md',
    assignee: 'hand', opener: 'lead', state: 'open', parked: true,
    openedAt: now - 90000, closedAt: null, lastActivityAt: now - 90000, nudgedAt: null,
  }]);
  const legacy = f.one('t1');
  assert.ok(!Object.prototype.hasOwnProperty.call(legacy, 'startedAt'), 'ENTER: old-format, no key');
  assert.strictEqual(legacy.parked, true, 'ENTER: and parked, which is the arm under test');
  // Not in the queue, but for the PARKED reason — asserted here so the two
  // exclusions cannot be confused with one another below.
  assert.deepStrictEqual(f.m._openTicketsFor(f.team, 'team-hand'), [], 'parked, so out of the queue either way');

  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'start', who: null, id: 't1', body: '' });
  assert.deepStrictEqual(f.gated, [{ target: 'team-hand', sender: 'lead', body: specBody('t1', 'filed for later\ndetail') }],
    'it starts — the old add never delivered a parked ticket, so this one demonstrably never ran');
  assert.ok(f.one('t1').startedAt != null, 'and it is stamped on the way through');
});

// A legacy NAME-ADDRESSED ticket carries neither `role` nor `worktree`:
// _repinTicketToSeat declines to write `role` when the assignee is a seat name
// rather than a role key. So "role or worktree means dispatched" is not
// sufficient on its own, and the absent-KEY arm is what catches these.
test('startedAt: a pre-upgrade name-addressed record has no role either, and still reads as started', () => {
  const f = mkStart();
  f.seat('lead'); f.seat('team-hand');
  const now = Date.now();
  f.tstore.save(f.team.root, [{
    id: 't1', title: 'legacy name-addressed', spec: 'legacy name-addressed',
    assignee: 'team-hand', opener: 'lead', state: 'open',
    openedAt: now - 90000, closedAt: null, lastActivityAt: now - 90000, nudgedAt: null,
  }]);
  const legacy = f.one('t1');
  assert.ok(!Object.prototype.hasOwnProperty.call(legacy, 'startedAt'), 'ENTER: old-format, no key');
  assert.strictEqual(legacy.role, undefined,
    'ENTER: and NO role — this is the shape a role-or-worktree reading would miss, so it is the one that pins the absent-key arm');
  assert.strictEqual(legacy.worktree, undefined, 'ENTER: and no worktree either');

  assert.deepStrictEqual(f.m._openTicketsFor(f.team, 'team-hand').map((t) => t.id), ['t1'],
    'still in the queue — this is the record a role-or-worktree-only reading would silently drop');
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'start', who: null, id: 't1', body: '' });
  assert.deepStrictEqual(f.gated, [], 'and not re-startable');
});

// The seam this whole field exists for. An added-but-unstarted ticket assigned
// to a ROLE matches every seat filling that role, so before this term the
// advance handed its spec to whichever seat closed a ticket first — including a
// seat working in a DIFFERENT ticket's worktree. That is `add` still
// dispatching, by a later edge.
test('an added-but-unstarted ticket is invisible to the advance, and startable afterwards', () => {
  const f = mkStart();
  f.seat('lead'); f.seat('team-hand');
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'the running one' });
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'start', who: null, id: 't1', body: '' });
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'merely filed' });
  assert.strictEqual(f.one('t2').startedAt, null, 'ENTER: t2 is filed but unstarted');
  assert.strictEqual(f.one('t1').state, 'open', 'ENTER: and t1 is the open one about to close');
  f.gated.length = 0;

  f.m._handleTask(f.seat('team-hand'), { type: 'task', sub: 'done', id: 't1', body: 'the report' });
  const toSeat = f.gated.filter((g) => g.target === 'team-hand');
  assert.deepStrictEqual(toSeat, [],
    'the unstarted ticket is NOT handed over on the completion edge — the lead files work, the lead starts it');

  // And nothing about it is broken by having been skipped: it is still exactly
  // what `start` dispatches. Without this the assertion above is also true of a
  // ticket the advance corrupted.
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'start', who: null, id: 't2', body: '' });
  assert.deepStrictEqual(f.gated.filter((g) => g.target === 'team-hand'),
    [{ target: 'team-hand', sender: 'lead', body: specBody('t2', 'merely filed') }],
    'and start still dispatches it normally');
});

test('an added-but-unstarted ticket is invisible to REPLAY too', () => {
  const f = mkStart();
  f.seat('lead');
  const s = f.seat('team-hand', '/proj');
  s.incarnation = 7;
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'merely filed' });
  assert.strictEqual(f.one('t1').startedAt, null, 'ENTER: filed, never started');
  f.gated.length = 0;
  assert.strictEqual(f.m._replayOpenTickets(s), true, 'the pass finishes — nothing is held');
  assert.deepStrictEqual(f.gated, [],
    'a respawn must not dispatch what the lead only filed — replay resumes work, it does not start it');
});

// ── t431: the task dir is a DISPATCH-time precondition ─────────────────────
// A ticket whose spec names no `tasks/…` path has nowhere for the review step
// to write its diff, so it cannot complete. That was discovered at VERIFY,
// after the hand had done the entire job: on t429 it cost two no-op rounds for
// a defect in the spec that was knowable the moment it was filed. Both
// lead-initiated dispatch verbs now refuse it up front.
//
// The refusal must land before ANYTHING is written — the assertions below are
// on the whole ticket record for that reason. A gate one line too late still
// refuses, still returns the right sentence, and has already minted the seat
// and cut the worktree; a partial assertion reads straight around it.

// Deliberately NOT run through `add`: `add` derives taskDir from the spec, so a
// spec that names no path is exactly how these records occur in the wild (three
// on the live board when this was written).
function openedNoTaskDir(f, who = 'hand', body = 'build the widget\nno artifact path anywhere') {
  f.state.autoTaskDir = false;   // the fixture's convenience stamp would erase the case under test
  f.seat('lead'); f.seat('team-hand');
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who, id: null, body });
  const t = f.one('t1');
  assert.strictEqual(t.taskDir, undefined, 'ENTER: no taskDir was extracted, or this measures the ordinary dispatch');
  return t;
}

test('t431: start refuses a ticket with no task dir', () => {
  const f = mkStart();
  openedNoTaskDir(f);
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'start', who: null, id: 't1', body: '' });
  assert.match(f.notes(), /ticket t1 has no task dir, so nothing was started/);
  assert.match(f.notes(), /names no `tasks\/…` path on any line/, 'names the actual defect');
  assert.match(f.notes(), /\[agent:task respec t1\]/, 'and the in-place fix — the ticket is open, so respec applies directly');
});

test('t431: the start refusal writes NOTHING — the record is byte-identical after it', () => {
  const f = mkStart();
  openedNoTaskDir(f);
  const before = JSON.parse(JSON.stringify(f.one('t1')));
  f.gated.length = 0; f.broadcasts.length = 0;
  const seatsBefore = [...f.m.sessions.keys()].sort();

  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'start', who: null, id: 't1', body: '' });

  // The WHOLE record, not a field: `startedAt`, `parked`, `role`, `assignee`,
  // `lastActivityAt`, `nudgedAt` and `worktree` are each written by a different
  // line of the dispatch, and a gate that lands between any two of them passes
  // every single-field assertion while having already done half the job.
  assert.deepStrictEqual(f.one('t1'), before, 'the ticket is exactly as it was found');
  assert.deepStrictEqual(f.gated, [], 'no spec delivered');
  assert.deepStrictEqual(f.broadcasts, [], 'and no board event — a refusal is not a dispatch');
  assert.deepStrictEqual([...f.m.sessions.keys()].sort(), seatsBefore, 'no seat minted');
});

test('t431: assign refuses a ticket with no task dir', () => {
  const f = mkStart();
  openedNoTaskDir(f);
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'assign', id: 't1', who: 'hand', body: '' });
  assert.match(f.notes(), /ticket t1 has no task dir, so nothing was assigned/);
  assert.match(f.notes(), /\[agent:task respec t1\]/);
});

test('t431: the assign refusal writes NOTHING either', () => {
  const f = mkStart();
  openedNoTaskDir(f);
  const before = JSON.parse(JSON.stringify(f.one('t1')));
  f.gated.length = 0; f.broadcasts.length = 0;
  const seatsBefore = [...f.m.sessions.keys()].sort();

  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'assign', id: 't1', who: 'hand', body: '' });

  assert.deepStrictEqual(f.one('t1'), before, 'the ticket is exactly as it was found');
  assert.deepStrictEqual(f.gated, [], 'nothing delivered — and in particular no stand-down notice to a previous holder');
  assert.deepStrictEqual(f.broadcasts, [], 'no board event');
  assert.deepStrictEqual([...f.m.sessions.keys()].sort(), seatsBefore, 'no seat minted');
});

// The control. Without it both refusals above are satisfied by a gate that
// refuses EVERY ticket, which would wedge the whole loop.
test('t431: a ticket WITH a task dir still dispatches, through both verbs', () => {
  const f = mkStart();
  f.seat('lead'); f.seat('team-hand');
  const spec = 'build the widget\ntasks/t1-widget/SPEC.md';
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: spec });
  assert.strictEqual(f.one('t1').taskDir, 'tasks/t1-widget/SPEC.md', 'ENTER: the path was extracted');
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'start', who: null, id: 't1', body: '' });
  assert.deepStrictEqual(f.gated, [{ target: 'team-hand', sender: 'lead', body: specBody('t1', spec) }],
    'start dispatches exactly as before');
  assert.ok(f.one('t1').startedAt, 'and stamps the dispatch');

  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: spec });
  f.gated.length = 0;
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'assign', id: 't2', who: 'hand', body: '' });
  assert.ok(f.gated.length >= 1, 'assign dispatches exactly as before');
  assert.ok(f.one('t2').startedAt, 'and stamps it too');
});

// The gate belongs to the dispatch VERB, not to the shared delivery funnel:
// `_deliverTicketSpec` also carries replays and redeliveries, and a ticket that
// is already dispatched must keep being able to replay its spec to a respawned
// seat. Gating the funnel would strand exactly the recovery a dead hand depends
// on — this pins that it did not happen.
test('t431: a dispatched task-dir-less ticket can still REPLAY to a respawned seat', () => {
  const f = mkStart();
  f.seat('lead');
  const s = f.seat('team-hand', '/proj');
  s.incarnation = 7;
  f.state.autoTaskDir = false;
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'legacy work, no path' });
  // Dispatched BEFORE the gate existed — the state every pre-upgrade ticket on
  // the board is in, and the one the verify-time backstop still exists for.
  const ts = f.load();
  ts[0].startedAt = Date.now(); ts[0].assignee = 'team-hand'; ts[0].role = 'hand';
  f.tstore.save(f.team.root, ts);
  assert.strictEqual(f.one('t1').taskDir, undefined, 'ENTER: still no task dir');
  f.gated.length = 0;

  assert.strictEqual(f.m._replayOpenTickets(s), true);
  assert.deepStrictEqual(f.gated.map((g) => g.target), ['team-hand'],
    'the replay still reaches the seat — the gate is on the dispatch verbs, not on the funnel');
});

// ── t550: a dispatch that reached nobody ───────────────────────────────────
//
// `startedAt` is stamped above all three delivery sites, so a dispatch to a role
// with no live seat is recorded as started — and that is CORRECT and deliberate:
// `_openTicketsFor` filters on `ticketStarted`, so a stamped ticket is picked up
// by `_replayOpenTickets` the moment a seat of that role spawns, and the stall
// sweep's orphan arm alarms about it exactly once. Rolling the stamp back would
// buy silence on both. What was wrong is the PROSE the record drives: nothing
// distinguished the miss from a real delivery, so every later reader described a
// spec no seat received as work a seat is doing.

test('t550: a dispatch to a role with no live seat is recorded as undelivered', () => {
  const f = mkStart();
  f.seat('lead');   // no team-hand — nothing for the role to resolve to
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'the spec' });
  assert.strictEqual(f.one('t1').undeliveredAt, undefined,
    'ENTER: add attempts no delivery, so the stamp below is the DISPATCH`s and not a leftover from filing');
  const before = Date.now();
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'start', who: null, id: 't1', body: '' });
  // ENTER: the dispatch really found nobody. A fixture that quietly had a seat
  // would make the absence of a stamp the expected outcome, and this whole
  // subject would pass while measuring the delivered path.
  assert.deepStrictEqual(f.gated, [], 'ENTER: nothing was delivered');
  assert.ok(f.one('t1').startedAt != null, 'ENTER: and it is still stamped started — the rollback this ticket declined');

  const t = f.one('t1');
  assert.ok(typeof t.undeliveredAt === 'number' && t.undeliveredAt >= before,
    'the miss is on the RECORD, so a reader after the dispatching turn can still tell it happened — '
    + 'the delivery-time NOTE says so once, into that turn`s reply, and is gone');
});

test('t550: assign records the same miss, and a later delivery clears it', () => {
  const f = mkStart();
  f.seat('lead');
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'the spec' });
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'assign', id: 't1', who: 'hand', body: '' });
  assert.deepStrictEqual(f.gated, [], 'ENTER: assign found nobody either');
  assert.ok(f.one('t1').undeliveredAt != null, 'assign is the OTHER dispatch path, so it records the miss too');

  // The seat comes up and the lead re-sends. The field answers for the LAST
  // dispatch: left stamped, the refusal and the board would keep reporting a miss
  // that has since been made good — the defect this ticket fixes, inverted.
  f.seat('team-hand');
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'assign', id: 't1', who: 'hand', body: '' });
  assert.strictEqual(f.gated.length, 1, 'ENTER: this time it landed');
  assert.strictEqual(f.one('t1').undeliveredAt, undefined,
    'and the stamp is GONE — a stale one would describe a ticket whose spec is now in a seat as one that reached nobody');
});

// The arm most likely to be got wrong and least likely to be noticed: `held` and
// `parked` are NOT misses. A seat EXISTS in both — parked drains on its next
// turn, held clears — so recording either as undelivered would tell the lead no
// seat ever got the spec about a seat that has it.
test('t550: held and parked are not recorded as undelivered — a seat exists in both', () => {
  for (const [label, ret] of [['held', { held: 'busy' }], ['parked', { parked: '/tmp/x', reason: 'quiet' }]]) {
    const f = mkStart();
    f.seat('lead'); f.seat('team-hand');
    f.m._gatedDeliver = (target, sender, body) => { f.gated.push({ target, sender, body }); return ret; };
    f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'the spec' });
    f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'start', who: null, id: 't1', body: '' });
    // ENTER: the delivery was ATTEMPTED and came back in the shape under test.
    // Without this the assertion below is equally true of a dispatch that never
    // reached _deliverTicketSpec at all.
    assert.strictEqual(f.gated.length, 1, `ENTER (${label}): the spec reached the delivery funnel`);
    assert.match(f.notes(), label === 'held' ? /spec NOT delivered/ : /spec parked/,
      `ENTER (${label}): and the funnel returned the ${label} shape, not a plain queue`);
    assert.strictEqual(f.one('t1').undeliveredAt, undefined,
      `${label} must not be recorded as undelivered: a seat exists and ${label === 'parked' ? 'the spec drains on its next turn' : 'it sees the spec when it clears'}`);
  }
});

// `self` is the third non-miss: the lead assigned the ticket to itself, so there
// is no seat to reach and nothing missing.
test('t550: a ticket the lead keeps is not recorded as undelivered', () => {
  const f = mkStart();
  f.seat('lead');
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'lead', id: null, body: 'mine' });
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'start', who: null, id: 't1', body: '' });
  assert.strictEqual(f.one('t1').assignee, 'lead', 'ENTER: it really is the lead`s own ticket');
  assert.deepStrictEqual(f.gated, [], 'ENTER: nothing is delivered to the lead — it wrote the spec');
  assert.strictEqual(f.one('t1').undeliveredAt, undefined,
    'the lead holding its own ticket is not a delivery that failed');
});

test('t550: a DELIVERED dispatch records no miss, and its refusal text is unchanged', () => {
  const f = mkStart();
  opened(f);
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'start', who: null, id: 't1', body: '' });
  assert.strictEqual(f.gated.length, 1, 'ENTER: it landed');
  assert.strictEqual(f.one('t1').undeliveredAt, undefined, 'a delivered dispatch stamps nothing');

  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'start', who: null, id: 't1', body: '' });
  assert.match(f.notes(), /already started — team-hand holds it/,
    'and the holder arm is untouched: it names the seat that has the work');
  assert.match(f.notes(), /\[agent:task assign t1 hand\] re-sends the spec to it/,
    'including the re-send, which is true when a seat holds it');
});

// The concrete instance the ticket was filed on. Before this, `holder` fell back
// to the ROLE KEY when nothing resolved, so the reply named "hand" as a holder
// and offered a re-send — both false in exactly the case the fallback existed for.
test('t550: the start refusal on an undelivered ticket claims neither a holder nor a re-send', () => {
  const f = mkStart();
  f.seat('lead');
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'the spec' });
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'start', who: null, id: 't1', body: '' });
  assert.deepStrictEqual(f.gated, [], 'ENTER: the dispatch reached nobody');
  assert.ok(f.one('t1').startedAt != null, 'ENTER: and start refuses it from here on');
  f.injected.length = 0;

  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'start', who: null, id: 't1', body: '' });
  const said = f.notes();
  assert.match(said, /already started/, 'ENTER: this is the already-started refusal and not some earlier one');
  // The two false phrases, pinned individually. Not "the message is truthful":
  // what is checked is the absence of a holder claim and the absence of a
  // re-send promise, so that is what the messages say.
  assert.doesNotMatch(said, /hand holds it/,
    'it must not name the ROLE as a holder — no seat ever received this spec');
  assert.doesNotMatch(said, /re-sends the spec/,
    'and must not offer a RE-send: there was no first send to repeat');
  assert.match(said, /no live seat holds it now/, 'it reports the liveness, which is what it can see');
  assert.match(said, /\[agent:task assign t1 hand\] sends the spec/,
    'and still points at assign, which is the verb that gets the spec to a seat');
});

// ONE holderless sentence, not two. An earlier round split it on `undeliveredAt`
// so a delivered-then-died ticket could still be offered a re-send — but that
// field records the last DISPATCH, and replay, advance and respec all deliver
// without touching it. Discriminating on it made the refusal assert delivery
// history it cannot know. This is the trace that broke it, and it is this
// ticket's own headline scenario.
test('t550: a spec delivered by REPLAY is never described as having reached no seat', () => {
  const f = mkStart();
  f.seat('lead');   // no team-hand yet
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'the spec' });
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'start', who: null, id: 't1', body: '' });
  assert.ok(f.one('t1').undeliveredAt != null, 'ENTER: the dispatch missed, and the record says so');

  // The seat spawns and replay delivers — the outcome the premise section calls
  // correct and intended, and the one that makes the stamp stale.
  const s = f.seat('team-hand');
  s.incarnation = 3;
  f.gated.length = 0;
  f.m._replayOpenTickets(s);
  // ENTER: the replay must actually have DELIVERED. Without this the subject is
  // equally true of a replay that found nothing to send, and the whole point is
  // that a real delivery happened after the miss was stamped.
  assert.deepStrictEqual(f.gated.map((g) => g.target), ['team-hand'],
    'ENTER: the spec really reached the seat');
  assert.ok(f.one('t1').undeliveredAt != null,
    'ENTER: and the stamp is STALE — replay does not clear it, which is why no message may branch on it');

  f.m.sessions.delete('team-hand');
  f.injected.length = 0;
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'start', who: null, id: 't1', body: '' });
  const said = f.notes();
  assert.match(said, /already started/, 'ENTER: the already-started refusal, not an earlier one');
  assert.doesNotMatch(said, /reached no seat/,
    'a seat received this spec and worked from it — saying the dispatch reached nobody is the false operator-facing claim this ticket exists to retire');
  assert.match(said, /no live seat holds it now/,
    'the refusal reports only what it can see: nothing holds it NOW, which is true of both holderless shapes');
});

// The other holderless shape, reaching the same sentence: this spec was delivered
// at dispatch and its seat died. One wording covers both because the refusal
// asserts nothing about delivery history — the property that makes it immune to
// the staleness above.
test('t550: a DELIVERED ticket whose seat died reaches the same holderless sentence', () => {
  const f = mkStart();
  opened(f);
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'start', who: null, id: 't1', body: '' });
  assert.strictEqual(f.gated.length, 1, 'ENTER: the spec reached team-hand');
  assert.strictEqual(f.one('t1').undeliveredAt, undefined, 'ENTER: and no miss was recorded');
  f.m.sessions.delete('team-hand');
  assert.strictEqual(f.m._ticketAssigneeSeat(f.team, f.one('t1')), null,
    'ENTER: and now nothing resolves — the same holderless state the miss produces');
  f.injected.length = 0;

  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'start', who: null, id: 't1', body: '' });
  const said = f.notes();
  assert.match(said, /no live seat holds it now/, 'it reports the liveness, which is what changed');
  assert.doesNotMatch(said, /reached no seat/,
    'and never the miss wording: this spec was delivered, and telling the lead otherwise sends it looking for a dispatch bug that is not there');
});

// ── t629: the refusal must not name a recovery that bounces ─────────────────
//
// `_resolveAssignee` accepts exactly two things — a key of `team.roles`, or a
// name in `_teamLiveSeatNames`. Both already-started refusals used to
// interpolate `ticket.role || assignee` raw, and neither of those fields is
// constrained to be one of the two: a NAME-addressed ticket carries no `role`
// and falls through to a seat name that is dead by the time this refusal runs,
// and a role key can be removed from team.json (`team role-remove`) while
// tickets still carry it. Either way the reply handed the lead a command
// `assign` then bounces — the same unusable-recovery failure `_taskPark`'s
// reply already guards against.
//
// The fix reads no field's PRESENCE. It asks the resolver, in order, whether
// `role` then `assignee` is something assign would accept, and falls back to
// the placeholder the file's other assign suggestions already use. That is why
// the assertions below run the emitted target back through `_resolveAssignee`
// rather than matching its spelling: a rewording that reintroduces a bouncing
// target reds regardless of how it is phrased, which pinning the sentence
// alone would not catch.

// The target out of `[agent:task assign <id> <target>]`. Deliberately not a
// loose scan for the seat name anywhere in the reply — the sentence names the
// dead seat legitimately elsewhere ("`team-hand` holds it"), so a whole-reply
// match would be satisfied by a bouncing command and by an honest one alike.
function assignTarget(said, id) {
  const m = said.match(new RegExp(`\\[agent:task assign ${id} ([^\\]]+)\\]`));
  assert.ok(m, `the refusal should still name an assign command for ${id} — got: ${said}`);
  return m[1];
}

test('t629: a NAME-addressed ticket whose seat died names no assign target rather than the dead name', () => {
  const f = mkStart();
  f.seat('lead'); f.seat('team-hand');
  // Addressed to the SEAT NAME, not the role: `_resolveAssignee` takes a live
  // seat name too, so this is a supported way to file a ticket and it writes
  // `assignee: 'team-hand'` with no `role`.
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'team-hand', id: null, body: 'the spec' });
  assert.strictEqual(f.one('t1').assignee, 'team-hand',
    'ENTER: the ticket is pinned to the NAME — a fixture that resolved `who` to the role would test the role path instead');
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'start', who: null, id: 't1', body: '' });
  assert.strictEqual(f.gated.length, 1, 'ENTER: the spec reached team-hand');
  assert.strictEqual(f.one('t1').role, undefined,
    'ENTER: and NO role was recorded — that absence is what made the old fallback reach for the seat name');

  f.m.sessions.delete('team-hand');
  assert.strictEqual(f.m._ticketAssigneeSeat(f.team, f.one('t1')), null,
    'ENTER: nothing resolves now, so the holderless arm is the one under test');
  // ENTER: the old target really would bounce. Without this the subject passes
  // on a team where `team-hand` happens to still be acceptable, and the
  // assertions below would be measuring nothing.
  assert.strictEqual(f.m._resolveAssignee(f.team, 'team-hand'), null,
    'ENTER: `assign t1 team-hand` is exactly what the resolver refuses');

  f.injected.length = 0;
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'start', who: null, id: 't1', body: '' });
  const said = f.notes();
  assert.match(said, /no live seat holds it now/, 'ENTER: the holderless refusal, not an earlier one');
  const target = assignTarget(said, 't1');
  assert.strictEqual(target, '<role|name>',
    'with nothing recoverable to name, the refusal names the PLACEHOLDER — stopping short beats pointing the lead at a command that bounces');
  // Guessing `hand` from the `team-hand` prefix would resolve and would read as
  // a fix. It is not one: the seat's role is not what the lead filed, and a seat
  // whose name does not decompose has no prefix to guess from at all.
  assert.doesNotMatch(target, /^hand$/, 'and it is not a role guessed out of the dead seat`s name');
});

test('t629: a role-addressed ticket with no live seat still names the ROLE, which resolves', () => {
  const f = mkStart();
  f.seat('lead');   // no team-hand — the role has nothing to resolve to
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'the spec' });
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'start', who: null, id: 't1', body: '' });
  assert.deepStrictEqual(f.gated, [], 'ENTER: the dispatch found nobody, so this ticket is holderless');

  f.injected.length = 0;
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'start', who: null, id: 't1', body: '' });
  const target = assignTarget(f.notes(), 't1');
  // The half that keeps the fix from being "always print the placeholder": a
  // recoverable target exists here and must still be named, because a lead handed
  // `<role|name>` for a ticket whose role is right there has to go look it up.
  assert.ok(f.m._resolveAssignee(f.team, target) != null,
    `the named target must be one assign accepts — got ${target}`);
  assert.strictEqual(target, 'hand', 'and it is the role the ticket was filed under');
});

test('t629: a live holder whose ticket carries a REMOVED role key falls through to the seat', () => {
  const f = mkStart();
  opened(f);
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'start', who: null, id: 't1', body: '' });
  assert.strictEqual(f.one('t1').role, 'hand',
    'ENTER: start re-pinned to the seat and recorded the role it was filed under');
  assert.strictEqual(f.one('t1').assignee, 'team-hand', 'ENTER: and the pin is the live seat');

  // `team role-remove` deletes the key outright (team-manifest.js), so a ticket
  // outliving its role is reachable without hand-editing a record.
  delete f.team.roles.hand;
  assert.strictEqual(f.m._resolveAssignee(f.team, 'hand'), null,
    'ENTER: `assign t1 hand` now bounces — the state the old raw `ticket.role` walked into');

  f.injected.length = 0;
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'start', who: null, id: 't1', body: '' });
  const said = f.notes();
  assert.match(said, /holds it/, 'ENTER: the LIVE-holder arm, which is the second of the two that interpolated the raw field');
  const target = assignTarget(said, 't1');
  assert.ok(f.m._resolveAssignee(f.team, target) != null,
    `the named target must be one assign accepts — got ${target}`);
  assert.strictEqual(target, 'team-hand',
    'the live seat is the recoverable target, and it is the seat the same sentence names as the holder');
});

// --- t673: per-ticket reviewer template selection ---------------------------
//
// The selection is stored on the RECORD, which is what makes a rework round
// reuse round 1's reviewer without a second place to keep the choice. All three
// facts below are about the record, because that is the only durable half —
// the spawn reads it fresh every round.

const SHELL_TPL = 'clodex-team-reviewer-shell';

// `systemPromptFile` is carried because the reviewer-name filter reads it: a
// template briefed by a HAND's prompt is not a reviewer arm, and a fixture that
// omitted the field would exercise a list the real one never produces.
function withTemplates(names) {
  return { getTemplates: () => ({ list: () => names.map((name) => ({ name, systemPromptFile: name })) }) };
}

test('t673: task add reviewer:<name> stores the choice on the record and names it back', () => {
  const f = mkStart(withTemplates(['clodex-team-reviewer', SHELL_TPL]));
  f.seat('lead'); f.seat('team-hand');
  f.m._handleTask(f.seat('lead'),
    { type: 'task', sub: 'add', who: 'hand', id: null, park: false, reviewer: SHELL_TPL, body: 'the spec' });
  const t = f.one('t1');
  assert.ok(t, 'ENTER: the ticket was actually filed — a refused add would leave every assertion below vacuous');
  assert.strictEqual(t.reviewerTemplate, SHELL_TPL);
  assert.match(f.notes(), /reviewer template: clodex-team-reviewer-shell/,
    'the lead is told the override took, not left to infer it from silence');
});

test('t673: an unknown reviewer template is refused AT ADD, with the list, and no ticket is filed', () => {
  // At add rather than at review time: a name that resolves to nothing becomes a
  // reviewer that fails to spawn after the work is done — an escalation on a
  // finished ticket instead of a typo the lead can fix in the line it just typed.
  const f = mkStart(withTemplates(['clodex-team-reviewer', SHELL_TPL]));
  f.seat('lead');
  f.m._handleTask(f.seat('lead'),
    { type: 'task', sub: 'add', who: 'hand', id: null, park: false, reviewer: 'no-such-template', body: 'the spec' });
  assert.deepStrictEqual(f.load(), [], 'nothing is filed — the refusal is not advisory');
  assert.match(f.notes(), /no template "no-such-template"/);
  assert.match(f.notes(), /clodex-team-reviewer-shell/, 'the available names are printed, so the fix needs no second guess');
});

test('t673: a template that is not a REVIEWER template is refused as a reviewer arm', () => {
  // The cap still holds, so this was never a hole — but a hand's template
  // spawned as the reviewer labels an A/B row with an arm that does not exist,
  // and the refusal text already promised "reviewer templates available".
  const f = mkStart({
    getTemplates: () => ({
      list: () => [
        { name: 'clodex-team-reviewer', systemPromptFile: 'clodex-team-reviewer' },
        { name: SHELL_TPL, systemPromptFile: SHELL_TPL },
        { name: 'clodex-hand-seat', systemPromptFile: 'clodex-hand-brief' },
      ],
    }),
  });
  f.seat('lead');
  f.m._handleTask(f.seat('lead'),
    { type: 'task', sub: 'add', who: 'hand', id: null, park: false, reviewer: 'clodex-hand-seat', body: 'the spec' });
  assert.deepStrictEqual(f.load(), [], 'the hand template is not offerable as a reviewer');
  const notes = f.notes();
  assert.match(notes, /no template "clodex-hand-seat"/);
  assert.match(notes, /clodex-team-reviewer-shell/, 'ENTER: the list really was printed, so its ABSENCE below is meaningful');
  assert.ok(!/clodex-hand-seat.*available|available.*clodex-hand-seat/s.test(notes.replace(/no template "clodex-hand-seat"/, '')),
    'and the hand template is not offered in it');
});

test('t673: task start reviewer:<name> writes the choice onto the record and names it back', () => {
  // The other half of the spec\'s selection surface. It parsed and was silently
  // discarded: no error, no note, and the DEFAULT reviewer — a no-op on exactly
  // the arm the A/B has to be able to pick.
  const f = mkStart(withTemplates(['clodex-team-reviewer', SHELL_TPL]));
  f.seat('lead'); f.seat('team-hand');
  const t0 = opened(f);
  assert.ok(!t0.reviewerTemplate, 'ENTER: the ticket starts with no template, so the write below is what put it there');
  f.m._handleTask(f.seat('lead'),
    { type: 'task', sub: 'start', who: null, id: t0.id, park: false, reviewer: SHELL_TPL, body: '' });
  assert.strictEqual(f.one(t0.id).reviewerTemplate, SHELL_TPL);
  assert.match(f.notes(), /reviewer template: clodex-team-reviewer-shell/);
});

test('t673: an unknown reviewer template is refused AT START, before anything is dispatched', () => {
  const f = mkStart(withTemplates(['clodex-team-reviewer', SHELL_TPL]));
  f.seat('lead'); f.seat('team-hand');
  const t0 = opened(f);
  f.m._handleTask(f.seat('lead'),
    { type: 'task', sub: 'start', who: null, id: t0.id, park: false, reviewer: 'no-such-template', body: '' });
  const after = f.one(t0.id);
  assert.match(f.notes(), /no template "no-such-template"/);
  assert.ok(!after.reviewerTemplate, 'nothing was written');
  assert.ok(!after.startedAt, 'and the ticket was NOT started — the refusal is not advisory');
});

test('t673: a ticket with no reviewer: token carries no reviewerTemplate at all', () => {
  // Absent, not null: every pre-upgrade record omits the key, and the spawn path
  // reads absent as "the team's own reviewer". A stored null would be a second
  // spelling of the same state.
  const f = mkStart(withTemplates(['clodex-team-reviewer', SHELL_TPL]));
  const t = opened(f);
  assert.ok(!Object.prototype.hasOwnProperty.call(t, 'reviewerTemplate'),
    'the key is omitted, matching how `parked` is written');
});

test('t681: an already-started ticket reports that, not the reviewer name, even when the name is bad', () => {
  const f = mkStart(withTemplates(['clodex-team-reviewer', SHELL_TPL]));
  const t0 = opened(f);
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'start', who: null, id: t0.id, park: false, reviewer: null, body: '' });
  assert.strictEqual(f.gated.length, 1, 'ENTER: the first start dispatched');
  f.m._handleTask(f.seat('lead'),
    { type: 'task', sub: 'start', who: null, id: t0.id, park: false, reviewer: 'no-such-template', body: '' });
  assert.strictEqual(f.gated.length, 1, 'the second start must not dispatch again');
  assert.match(f.notes(), new RegExp(`ticket ${t0.id} is already started`),
    'the state refusal wins over the reviewer-name refusal on an already-dispatched ticket');
  assert.doesNotMatch(f.notes(), /no template "no-such-template"/);
});
