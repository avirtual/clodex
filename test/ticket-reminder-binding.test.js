'use strict';
// Run: node --test test/ticket-reminder-binding.test.js
//
// t395 — a reminder bound to a ticket (`[agent:remind for t42 in 40m]`) is
// cancelled when that ticket reaches a TERMINAL close, and is left armed by
// everything else.
//
// WHY THE ASSERTIONS ARE SHAPED THE WAY THEY ARE. Almost every claim here is an
// absence — "the reminder is gone", "no reminder was touched" — and an absence
// is TRUE of a store that never held the record at all. An `add` that silently
// failed to bind (the exact defect this ticket exists to prevent) would make the
// whole file pass while measuring nothing. So every subject asserts the ENTER
// state first: the record EXISTS and carries `ticket: '<id>'` immediately before
// the close runs. Those are not ceremony — they are the only thing standing
// between this file and a green suite over a feature that does not work.
//
// The survival subjects assert presence AND that the reminder is still SCHEDULED
// (nextFireAt unchanged, timer still armed), not merely that no error was
// thrown: a reminder left in the store with its fire time nulled is cancelled in
// every sense that matters, and `assert.ok(store.get(id))` cannot see it.
//
// The store and the scheduler are REAL throughout (a temp userData dir + the
// fake clock the scheduler's own suite uses). A stubbed scheduler would prove
// only that the close path calls the function it calls, and the claim here is
// that a record actually leaves a real store.

const { test } = require('node:test');
const assert = require('node:assert');
const fsReal = require('node:fs');
const pathReal = require('node:path');
const osReal = require('node:os');

const { initStores } = require('../stores');
const { createRemindScheduler } = require('../remind-scheduler');
const { parseRemindSpec } = require('../remind-schedule');
const { createSessionManager } = require('../session-manager');
const ticketsMod = require('../tickets-store');
const { intentEnabled } = require('../intent-catalog');

const T0 = Date.UTC(2026, 7, 14, 9, 0, 0);
const MIN = 60 * 1000;

// Same fake clock as test/remind-scheduler.test.js: `now` is a mutable epoch and
// setTimer records a due time, so "still armed" is an observable fact (a pending
// timer) rather than an inference.
function fakeClock(startMs) {
  let cur = startMs;
  let seq = 0;
  const timers = new Map();
  return {
    now: () => cur,
    setTimer: (fn, delay) => { const h = ++seq; timers.set(h, { at: cur + delay, fn }); return h; },
    clearTimer: (h) => { timers.delete(h); },
    advance(ms) {
      const target = cur + ms;
      for (;;) {
        let next = null;
        for (const [h, t] of timers) {
          if (t.at <= target && (next === null || t.at < next.t.at)) next = { h, t };
        }
        if (!next) break;
        timers.delete(next.h);
        cur = next.t.at;
        next.t.fn();
      }
      cur = target;
    },
    pending: () => timers.size,
  };
}

// A manager wired to a REAL tickets store and a REAL remind scheduler over the
// same temp home, with a lead seat and two open tickets (t1, t2).
//
// `_reconcileTickets` / `_advanceSeat` / `_writeTicketCost` are stubbed: they are
// the cancel path's unrelated collaborators (dispatch bookkeeping and cost
// accounting), and driving them for real would pull worktrees and cost ledgers
// into a fixture whose whole subject is which reminders survive.
function mkFixture() {
  const home = fsReal.mkdtempSync(pathReal.join(osReal.tmpdir(), 'clodex-t395-'));
  const userData = fsReal.mkdtempSync(pathReal.join(osReal.tmpdir(), 'clodex-t395-ud-'));
  const repoDir = fsReal.mkdtempSync(pathReal.join(osReal.tmpdir(), 'clodex-t395-repo-'));

  const stores = initStores(userData, { log: console, registryDir: home });
  const clock = fakeClock(T0);
  const fires = [];
  const scheduler = createRemindScheduler({
    now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    store: stores.reminders,
    deliver: (agent, id, spec, body) => fires.push({ agent, id, spec, body }),
  });

  const tstore = ticketsMod.createTicketsStore({ clodexHome: home });
  const team = {
    name: 'team', root: repoDir, lead: 'lead', watchdogMs: null,
    file: pathReal.join(home, 'teams', 'team', 'team.json'),
    roles: {
      lead: { instantiate: 'session', brief: 'the lead' },
      hand: { instantiate: 'session', brief: 'the hand' },
    },
  };
  const mkTicket = (id) => ({
    id, state: 'open', spec: `spec for ${id}`, assignee: 'team-hand', role: 'hand',
    openedAt: T0, lastActivityAt: T0, startedAt: T0,
  });
  tstore.save(team.root, [mkTicket('t1'), mkTicket('t2')]);

  const store = [];
  const persistence = {
    list: () => store,
    get: (n) => store.find((e) => e.name === n) || null,
    upsert: (e) => {
      const i = store.findIndex((x) => x.name === e.name);
      if (i >= 0) store[i] = { ...store[i], ...e }; else store.push({ ...e });
    },
    remove: (n) => { const i = store.findIndex((x) => x.name === n); if (i >= 0) store.splice(i, 1); },
    setStripLevel: () => {},
    setAutoCompact: () => {},
  };

  const logs = [];
  const injected = [];
  const broadcasts = [];
  const deps = {
    getRemoteServer: () => null,
    getUiSettings: () => ({ get: () => ({}) }),
    getPersistence: () => persistence,
    getTemplates: () => ({ list: () => [] }),
    getRemindScheduler: () => scheduler,
    // The REAL parser, as engine.js injects it. Omitting it does not fail
    // loudly by luck — it arrived as `undefined` here first time round and every
    // arm threw a TypeError, which is the visible end of the failure mode
    // CLAUDE.md names; a subject that swallowed the throw would have measured a
    // fixture in which no reminder can ever be armed.
    parseRemindSpec,
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
    pathFor: require('../clodex-paths').pathFor,
    runDirFor: require('../clodex-paths').runDirFor,
    os: osReal,
    ensureDir: require('../fs-util').ensureDir,
    gitWorktree: require('../git-worktree'),
    childProcess: require('node:child_process'),
    countPending: require('../pending-store').countPending,
    isDraftOpen: require('../proxy-util').isDraftOpen,
    drainPending: require('../pending-store').drainPending,
    hasActivePending: require('../pending-store').hasActivePending,
    spillToFile: () => '/tmp/spill-stub.txt',
    MSG_MAX_AGE: 1800,
    termAvailableFor: require('../drawer-avail').termAvailableFor,
    REGISTRY_DIR: home,
    log: {
      info: (tag, msg) => logs.push({ level: 'info', tag, msg }),
      warn: (tag, msg) => logs.push({ level: 'warn', tag, msg }),
      error: (tag, msg) => logs.push({ level: 'error', tag, msg }),
      debug: () => {},
    },
    resolveTeam: (cwd) => (cwd && cwd.startsWith(repoDir) ? team : null),
    findProjectRoot: (cwd) => (cwd && cwd.startsWith(repoDir) ? repoDir : null),
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
  m._gatedDeliver = () => ({ queued: true });
  m._deliverMessage = () => {};
  m._deliverPassive = () => {};
  m._deliverParkedActive = () => {};
  m._reconcileTickets = () => {};
  m._advanceSeat = () => null;
  m._writeTicketCost = () => {};

  const seat = (name) => {
    m.sessions.set(name, {
      name, type: 'claude', agentType: 'claude', cwd: repoDir,
      pty: { pid: 1 }, activityState: 'idle',
    });
    return m.sessions.get(name);
  };
  const lead = seat('lead');
  seat('team-hand');

  const replies = [];
  const reply = (msg) => replies.push(msg);

  return {
    m, team, lead, reply, replies, tstore, scheduler, clock, fires, logs, injected,
    store: stores.reminders,
    one: (id) => tstore.load(team.root).find((t) => t.id === id),
    setState: (id, patch) => {
      const all = tstore.load(team.root);
      const row = all.find((t) => t.id === id);
      Object.assign(row, patch);
      tstore.save(team.root, all);
    },
    // Arm through the REAL intent handler, so what these subjects create is what
    // an agent's `[agent:remind …]` line actually creates — binding validation
    // included. A record planted straight into the store would bypass the
    // existence check and could carry a binding the shipped path refuses.
    arm: (spec, body = 'body') => {
      m._handleRemindIntent(lead, spec, body);
      return stores.reminders.listForAgent('lead');
    },
    cleanup() {
      scheduler.stop();
      try { fsReal.rmSync(home, { recursive: true, force: true }); } catch {}
      try { fsReal.rmSync(userData, { recursive: true, force: true }); } catch {}
      try { fsReal.rmSync(repoDir, { recursive: true, force: true }); } catch {}
    },
  };
}

// The bound record for a ticket, or undefined. Used for the ENTER assertions.
const boundTo = (store, agent, ticketId) =>
  store.listForAgent(agent).find((r) => r.ticket === ticketId);

// ── the grammar ────────────────────────────────────────────────────────────

test('the `for <id>` prefix binds, and every schedule kind still parses its own tail', () => {
  // deepStrictEqual on the WHOLE result, not a property probe: the binding must
  // not disturb the schedule fields, and a partial match would read around a
  // `delayMs` the prefix peel had eaten.
  assert.deepStrictEqual(parseRemindSpec('for t42 in 40m'),
    { ok: true, kind: 'in', delayMs: 40 * MIN, ticket: 't42' });
  assert.deepStrictEqual(parseRemindSpec('for t42 every 30m'),
    { ok: true, kind: 'every', intervalMs: 30 * MIN, ticket: 't42' });
  assert.deepStrictEqual(parseRemindSpec('for t42 at 14:30'),
    { ok: true, kind: 'at', hh: 14, mm: 30, ticket: 't42' });
  assert.deepStrictEqual(parseRemindSpec('for t42 on compact'),
    { ok: true, kind: 'oncompact', ticket: 't42' });

  // cron is the arm a SUFFIX grammar could not have handled: it counts exactly 5
  // whitespace fields, so a trailing `for t42` would make it 7 and bounce. The
  // prefix leaves the expression untouched — this is the subject that pins the
  // prefix choice as load-bearing rather than stylistic.
  const c = parseRemindSpec('for t42 cron 0 9 * * *');
  assert.strictEqual(c.ok, true, 'ENTER: a bound cron parses at all');
  assert.strictEqual(c.kind, 'cron');
  assert.strictEqual(c.ticket, 't42');
  assert.deepStrictEqual([...c.cron.hour], [9], 'the cron fields survive the peel intact');

  // An ISO `at` contains no whitespace to confuse the peel, and must round-trip.
  assert.deepStrictEqual(parseRemindSpec('for t7 at 2026-08-14T10:00:00Z'),
    { ok: true, kind: 'at', atMs: Date.parse('2026-08-14T10:00:00Z'), ticket: 't7' });
});

test('an unbound spec is untouched by the binding grammar', () => {
  // The regression guard for the peel: every pre-existing form must parse to
  // exactly what it did before, with NO ticket key present at all.
  assert.deepStrictEqual(parseRemindSpec('in 40m'), { ok: true, kind: 'in', delayMs: 40 * MIN });
  assert.deepStrictEqual(parseRemindSpec('list'), { ok: true, kind: 'list' });
  assert.deepStrictEqual(parseRemindSpec('cancel abc'), { ok: true, kind: 'cancel', id: 'abc' });
  assert.ok(!('ticket' in parseRemindSpec('every 30m')), 'no ticket key on an unbound schedule');
});

test('an unparseable or misplaced binding bounces LOUDLY, never arms unbound', () => {
  // Each of these must be ok:false. A binding that degrades to "just do not
  // bind" is the original bug with the visible warning removed, so the negative
  // (`ok !== true`) is the whole point and the message is asserted alongside it
  // to pin WHICH failure was reported.
  const cases = [
    ['for', /needs a ticket id/],
    ['for t42', /needs a schedule after it/],
    ['for xyz in 1h', /invalid ticket id "xyz"/],
    ['for 42 in 1h', /invalid ticket id "42"/],
    ['for t42 list', /cannot be combined with "list"/],
    ['for t42 cancel abc', /cannot be combined with "cancel"/],
    ['for t42 in bogus', /bad duration/],
    ['for t42 nonsense 5', /unknown remind form/],
  ];
  for (const [spec, re] of cases) {
    const r = parseRemindSpec(spec);
    assert.strictEqual(r.ok, false, `"${spec}" must bounce, not arm`);
    assert.match(r.error, re, `"${spec}" bounces with the reason that fits it`);
  }
});

// ── the scheduler ──────────────────────────────────────────────────────────

test('cancelForTicket drops only the caller\'s reminders bound to that ticket', () => {
  const f = mkFixture();
  try {
    const { scheduler, store } = f;
    const a = scheduler.add('lead', 'for t1 in 40m', 'about t1');
    const b = scheduler.add('lead', 'for t2 in 40m', 'about t2');
    const c = scheduler.add('lead', 'in 40m', 'unbound');
    const d = scheduler.add('other', 'for t1 in 40m', 'another agent, same ticket');
    for (const r of [a, b, c, d]) assert.strictEqual(r.ok, true, 'ENTER: all four armed');
    assert.strictEqual(store.get(a.record.id).ticket, 't1', 'ENTER: a is bound to t1');
    assert.strictEqual(store.get(d.record.id).ticket, 't1', 'ENTER: d is bound to t1 too');

    const dropped = scheduler.cancelForTicket('lead', 't1');

    assert.deepStrictEqual(dropped, [a.record.id], 'exactly the one bound record is reported');
    assert.strictEqual(store.get(a.record.id), null, 'the bound record is gone');
    // Ownership: `d` is bound to the SAME ticket but owned by another agent, so
    // the same-agent rule cancel() enforces must hold here too.
    assert.ok(store.get(d.record.id), 'another agent\'s reminder on the same ticket survives');
    assert.strictEqual(store.get(d.record.id).ticket, 't1', 'and is still bound');
    assert.ok(store.get(b.record.id), 'a reminder bound to a different ticket survives');
    assert.ok(store.get(c.record.id), 'an unbound reminder survives');
  } finally { f.cleanup(); }
});

test('cancelForTicket on a ticket with no bound reminders touches nothing', () => {
  const f = mkFixture();
  try {
    const { scheduler, store } = f;
    const c = scheduler.add('lead', 'in 40m', 'unbound');
    assert.strictEqual(store.list().length, 1, 'ENTER: exactly one record exists');

    assert.deepStrictEqual(scheduler.cancelForTicket('lead', 't1'), []);
    assert.deepStrictEqual(scheduler.cancelForTicket('lead', null), []);

    assert.strictEqual(store.list().length, 1, 'the store is unchanged');
    assert.strictEqual(store.get(c.record.id).nextFireAt, T0 + 40 * MIN, 'and still scheduled');
  } finally { f.cleanup(); }
});

// ── arming through the intent handler ──────────────────────────────────────

test('arming with a binding to a REAL ticket stores the binding', () => {
  const f = mkFixture();
  try {
    const mine = f.arm('for t1 in 40m', 'check t1');
    assert.strictEqual(mine.length, 1, 'ENTER: the reminder actually armed');
    assert.strictEqual(mine[0].ticket, 't1', 'and carries the binding');
    assert.strictEqual(mine[0].nextFireAt, T0 + 40 * MIN, 'and is scheduled');
    assert.strictEqual(mine[0].spec, 'for t1 in 40m', 'the verbatim spec round-trips');
  } finally { f.cleanup(); }
});

test('a binding to a ticket that is not on the board BOUNCES and arms nothing', () => {
  const f = mkFixture();
  try {
    // The defect this refuses: a reminder bound to t999 can never be cancelled,
    // because no close will ever name it — which is the orphan bug exactly,
    // minus the visible sign that something was supposed to happen.
    const mine = f.arm('for t999 in 40m', 'check t999');
    assert.deepStrictEqual(mine, [], 'nothing was armed');
    assert.match(f.injected.join('\n'), /no ticket t999 on team/, 'and the seat was told why');
  } finally { f.cleanup(); }
});

// ── the close paths ────────────────────────────────────────────────────────

test('accept cancels the reminders bound to that ticket', async () => {
  const f = mkFixture();
  try {
    f.arm('for t1 in 40m', 'check t1 has landed');
    const before = boundTo(f.store, 'lead', 't1');
    assert.ok(before, 'ENTER: a reminder exists and is bound to t1 before the accept');
    assert.strictEqual(before.nextFireAt, T0 + 40 * MIN, 'ENTER: and it is scheduled');

    f.setState('t1', { state: 'done', report: 'did it' });
    await f.m._taskAccept(f.lead, f.team, { id: 't1' }, f.reply);

    assert.strictEqual(f.store.get(before.id), null, 'the bound reminder is gone from the store');
    assert.match(f.replies.join('\n'), /1 bound reminder\(s\) cancelled/, 'and the lead is told');
  } finally { f.cleanup(); }
});

test('cancel cancels the reminders bound to that ticket', () => {
  const f = mkFixture();
  try {
    f.arm('for t1 in 40m', 'check t1 has landed');
    const before = boundTo(f.store, 'lead', 't1');
    assert.ok(before, 'ENTER: a reminder exists and is bound to t1 before the cancel');

    f.m._taskCancel(f.lead, f.team, { id: 't1', body: 'dropped' }, f.reply);

    assert.strictEqual(f.one('t1').state, 'cancelled', 'ENTER: the close actually happened');
    assert.strictEqual(f.store.get(before.id), null, 'the bound reminder is gone');
    assert.match(f.replies.join('\n'), /1 bound reminder\(s\) cancelled/);
  } finally { f.cleanup(); }
});

test('an UNBOUND reminder survives the close of an unrelated ticket, still scheduled', () => {
  const f = mkFixture();
  try {
    f.arm('in 40m', 'nothing to do with tickets');
    const before = f.store.listForAgent('lead')[0];
    assert.ok(before, 'ENTER: the reminder armed');
    assert.ok(!before.ticket, 'ENTER: and is unbound');
    const armedTimers = f.clock.pending();
    assert.ok(armedTimers > 0, 'ENTER: a timer is actually armed for it');

    f.m._taskCancel(f.lead, f.team, { id: 't1', body: 'dropped' }, f.reply);

    assert.strictEqual(f.one('t1').state, 'cancelled', 'ENTER: the close actually happened');
    const after = f.store.get(before.id);
    assert.ok(after, 'the unbound reminder is still present');
    // Presence alone is not survival: a record whose fire time was nulled is
    // cancelled in every sense that matters, and `ok(after)` cannot see it.
    assert.strictEqual(after.nextFireAt, T0 + 40 * MIN, 'and still SCHEDULED, not just present');
    assert.ok(f.clock.pending() > 0, 'and a timer is still armed');
    // It genuinely still fires.
    f.clock.advance(41 * MIN);
    assert.deepStrictEqual(f.fires.map((x) => x.body), ['nothing to do with tickets']);
    assert.doesNotMatch(f.replies.join('\n'), /bound reminder/, 'and the reply claims no cancellation');
  } finally { f.cleanup(); }
});

test('a reminder bound to t1 survives the close of t2', async () => {
  const f = mkFixture();
  try {
    f.arm('for t1 in 40m', 'about t1');
    const before = boundTo(f.store, 'lead', 't1');
    assert.ok(before, 'ENTER: a reminder exists and is bound to t1');

    f.setState('t2', { state: 'done', report: 'did t2' });
    await f.m._taskAccept(f.lead, f.team, { id: 't2' }, f.reply);

    assert.ok(f.one('t2').acceptedAt, 'ENTER: t2 was really accepted');
    const after = f.store.get(before.id);
    assert.ok(after, 'the t1-bound reminder survives');
    assert.strictEqual(after.ticket, 't1', 'still bound to t1');
    assert.strictEqual(after.nextFireAt, T0 + 40 * MIN, 'and still scheduled');
    f.clock.advance(41 * MIN);
    assert.deepStrictEqual(f.fires.map((x) => x.body), ['about t1'], 'and it still fires');
  } finally { f.cleanup(); }
});

test('`done` does NOT cancel, and a following `reject` leaves the reminder armed', () => {
  const f = mkFixture();
  try {
    // The lifecycle ruling this whole feature turns on: `done` is not terminal.
    // A reject reopens the ticket, the seat does another round, and the reminder
    // is still wanted for it — so cancelling on `done` would silently disarm the
    // rework round's reminder.
    f.arm('for t1 in 40m', 'about t1');
    const before = boundTo(f.store, 'lead', 't1');
    assert.ok(before, 'ENTER: a reminder exists and is bound to t1');

    const hand = f.m.sessions.get('team-hand');
    f.m._taskDone(hand, f.team, { id: 't1', body: 'I did the work.' }, f.reply);
    assert.strictEqual(f.one('t1').state, 'done', 'ENTER: done really landed');

    const afterDone = f.store.get(before.id);
    assert.ok(afterDone, 'done leaves the reminder in place');
    assert.strictEqual(afterDone.nextFireAt, T0 + 40 * MIN, 'and still scheduled');

    f.m._taskReject(f.lead, f.team, { id: 't1', body: 'fix the thing' }, f.reply);
    assert.strictEqual(f.one('t1').state, 'open', 'ENTER: reject reopened the ticket');
    assert.strictEqual(Number(f.one('t1').reworkRound), 1, 'ENTER: and it is a rework round');
    assert.strictEqual(f.one('t1').closedAt, null, 'ENTER: and the close was really undone');

    const afterReject = f.store.get(before.id);
    assert.ok(afterReject, 'the reminder is STILL armed through the rework round');
    assert.strictEqual(afterReject.ticket, 't1', 'and still bound');
    assert.strictEqual(afterReject.nextFireAt, T0 + 40 * MIN, 'and still scheduled');
    f.clock.advance(41 * MIN);
    assert.deepStrictEqual(f.fires.map((x) => x.body), ['about t1'], 'and it fires for the rework');
  } finally { f.cleanup(); }
});

test('a LEAD-emitted `done` does not cancel either — the verb decides, not the closer', () => {
  const f = mkFixture();
  try {
    // The subject above has the HAND emitting done, and that alone cannot pin
    // the ruling: the reminder is owned by the lead, so same-agent ownership
    // makes a done-cancels-too defect a no-op on that path, and the assertion
    // passes under the defect as well as the fix — discriminating nothing.
    // The lead may close its own ticket with `done` (the isLead arm of
    // _taskDone), and there ownership does NOT mask it. This is the subject that
    // actually kills the mutant.
    f.arm('for t1 in 40m', 'about t1');
    const before = boundTo(f.store, 'lead', 't1');
    assert.ok(before, 'ENTER: a reminder exists, bound to t1, OWNED BY THE LEAD');
    assert.strictEqual(before.agent, 'lead', 'ENTER: owner is the lead, so ownership cannot mask a defect');

    f.m._taskDone(f.lead, f.team, { id: 't1', body: 'closing my own ticket.' }, f.reply);
    assert.strictEqual(f.one('t1').state, 'done', 'ENTER: the lead\'s done really landed');
    assert.strictEqual(f.one('t1').closedBy, 'lead', 'ENTER: and it was the lead that closed it');

    const after = f.store.get(before.id);
    assert.ok(after, '`done` is not terminal — the reminder stays armed');
    assert.strictEqual(after.nextFireAt, T0 + 40 * MIN, 'and still scheduled');
    assert.doesNotMatch(f.replies.join('\n'), /bound reminder/, 'and nothing claims a cancellation');
  } finally { f.cleanup(); }
});

test('accept after a reject round finally cancels it', async () => {
  const f = mkFixture();
  try {
    // Closing the loop the previous subject opens: the reminder survives the
    // round, and the eventual TERMINAL close still collects it. Without this the
    // suite would be consistent with a binding that is never cancelled at all
    // once a ticket has been rejected once.
    f.arm('for t1 in 40m', 'about t1');
    const before = boundTo(f.store, 'lead', 't1');
    assert.ok(before, 'ENTER: bound reminder exists');

    const hand = f.m.sessions.get('team-hand');
    f.m._taskDone(hand, f.team, { id: 't1', body: 'round one.' }, f.reply);
    f.m._taskReject(f.lead, f.team, { id: 't1', body: 'again' }, f.reply);
    f.m._taskDone(hand, f.team, { id: 't1', body: 'round two.' }, f.reply);
    assert.strictEqual(f.one('t1').state, 'done', 'ENTER: re-closed after rework');
    assert.ok(f.store.get(before.id), 'ENTER: the reminder is still armed at this point');

    await f.m._taskAccept(f.lead, f.team, { id: 't1' }, f.reply);

    assert.ok(f.one('t1').acceptedAt, 'ENTER: the accept landed');
    assert.strictEqual(f.store.get(before.id), null, 'the terminal close collects it');
  } finally { f.cleanup(); }
});

test('several reminders bound to one ticket all go, in one close', async () => {
  const f = mkFixture();
  try {
    f.arm('for t1 in 40m', 'first');
    f.arm('for t1 every 30m', 'second');
    f.arm('for t2 in 40m', 'other ticket');
    f.arm('in 40m', 'unbound');
    const bound = f.store.listForAgent('lead').filter((r) => r.ticket === 't1');
    assert.strictEqual(bound.length, 2, 'ENTER: two reminders are bound to t1');
    assert.strictEqual(f.store.list().length, 4, 'ENTER: four records in total');

    f.setState('t1', { state: 'done', report: 'did it' });
    await f.m._taskAccept(f.lead, f.team, { id: 't1' }, f.reply);

    assert.deepStrictEqual(f.store.listForAgent('lead').map((r) => r.body).sort(),
      ['other ticket', 'unbound'], 'exactly the two t1-bound records left');
    assert.match(f.replies.join('\n'), /2 bound reminder\(s\) cancelled/);
  } finally { f.cleanup(); }
});
