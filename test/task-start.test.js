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
    const r = handleTask(session, intent);
    if (state.autoTaskDir && intent && intent.type === 'task' && intent.sub === 'add') {
      const ts = tstore.load(team.root);
      let touched = false;
      for (const t of ts) if (!t.taskDir) { t.taskDir = `tasks/${t.id}-fixture/SPEC.md`; touched = true; }
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
