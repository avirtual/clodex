'use strict';
// Run: node --test test/team-review-window-guard.test.js
//
// t441 — a bare `[agent:team-review]` is REFUSED while a ticket sits in the
// loop's `verify` step, and the loop's own call is not.
//
// The window: `task done` stamps `loopStep: 'verify'` and the loop mints its
// reviewer only after the branch's full suite passes — MINUTES, not the 74-81s
// spawn latency measured after it. For that whole run the ticket looks
// unreviewed and is not, so a lead firing a bare team-review spawns a SECOND,
// unattached reviewer — `opts.ticketId` is what binds a verdict to a ticket, and
// an intent-driven call passes none, so that reviewer re-reads the whole diff and
// reports to nobody. Five occurrences, three in one day.
//
// The load-bearing subject here is the NEGATIVE one: the loop reaches the same
// handler, with `ticketId`, for a ticket that is in `verify` by definition. A
// guard that read the board without checking `reviewTicket` first would refuse
// the spawn it exists to protect and every ticket would stall at review
// permanently. That case is `the loop's own call is NOT refused` below.
//
// FIXTURE VISIBILITY — the trap that ate an evening. `ticketsStore.load(root)`
// does NOT read `<root>/tickets.json`; it resolves through
// `projectDirFor(home, root)`, and `load` is best-effort (a missing or
// unreadable file is `[]`, never a throw). A fixture written to the wrong path
// therefore produces NO error — the guard just sees an empty board and falls
// through to spawning. So the store here is constructed on the same temp
// `clodexHome` the manager is given (`REGISTRY_DIR`), and every refusal
// assertion below matches the TICKET ID in the message: an id an empty board
// cannot produce is the proof the fixture reached the code under test.

const { test } = require('node:test');
const assert = require('node:assert');
const fsReal = require('node:fs');
const pathReal = require('node:path');
const osReal = require('node:os');

const { createSessionManager } = require('../session-manager');
const ticketsMod = require('../tickets-store');
const { intentEnabled } = require('../intent-catalog');
const { mkTmpRoot } = require('./lib/tmp-roots');

// Copied, not shared, for the reason reviewer-ticket-name.test.js states: these
// assertions are about the GUARD, and a shared fixture makes either file's edits
// break the other.
const SHIPPED_REVIEWER_TEMPLATE = {
  name: 'clodex-team-reviewer',
  systemPromptFile: 'clodex-team-reviewer',
  intents: [],
  tools: ['Read', 'Grep', 'Glob'],
  env: {
    CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1',
    FORCE_PROMPT_CACHING_5M: '1',
    CLODEX_DISABLE_IPC_PROMPT: '1',
    CLODEX_SPAWNER_HINT: 'off',
    CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS: '60000',
  },
};

function mkFixture() {
  const home = mkTmpRoot('clodex-rtn-');
  const tstore = ticketsMod.createTicketsStore({ clodexHome: home });
  const team = {
    name: 'team', root: '/proj', lead: 'lead', watchdogMs: null,
    file: pathReal.join(home, 'teams', 'team', 'team.json'),
    roles: {
      lead: { instantiate: 'session', brief: 'the lead' },
      hand: { instantiate: 'session', brief: 'the hand' },
      reviewer: {
        instantiate: 'subagent', prompt: 'clodex-team-reviewer', brief: 'the reviewer',
        tools: ['Read', 'Grep', 'Glob'], type: null, template: null, standing: null, ephemeral: false,
      },
    },
  };
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
  const injected = [];
  const gated = [];
  const deps = {
    getRemoteServer: () => null,
    getUiSettings: () => ({ get: () => ({}) }),
    getPersistence: () => persistence,
    getTemplates: () => ({ list: () => [SHIPPED_REVIEWER_TEMPLATE] }),
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
    os: osReal,
    ensureDir: require('../fs-util').ensureDir,
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
  };
  const SessionManager = createSessionManager(deps);
  const m = new SessionManager();
  const killed = [];
  m._injectText = (s, text, opts) => {
    const out = opts && typeof opts.produce === 'function' ? opts.produce() : text;
    if (out == null || out === '') return;
    injected.push(out);
  };
  m._broadcast = () => {};
  m._sendToSession = () => {};
  m._gatedDeliver = (target, sender, body) => { gated.push({ target, sender, body }); return { queued: true }; };
  m._deliverMessage = () => {};
  m._deliverPassive = () => {};
  m._deliverParkedActive = () => {};
  m.create = async () => {};
  // The reap, verbatim from kill()'s own behaviour: a retiring reviewer's record
  // is REMOVED, which is what frees the name for the next mint.
  m.kill = async (name) => { killed.push(name); persistence.remove(name); m.sessions.delete(name); };
  const seat = (name, cwd = '/proj') => {
    m.sessions.set(name, { name, type: 'claude', agentType: 'claude', cwd, pty: { pid: 1 }, activityState: 'idle' });
    return m.sessions.get(name);
  };
  return {
    m, team, home, tstore, persistence, injected, gated, killed, seat,
    one: (id) => tstore.load(team.root).find((t) => t.id === id),
  };
}

function openTicket(f, body = 'the spec') {
  f.seat('lead'); f.seat('team-hand');
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body });
  // Dispatch refuses a ticket whose spec names no `tasks/…` path, and these
  // bodies deliberately carry none — stamped on the record so the bodies stay
  // the subject. Without it `start` is silently refused and every helper below
  // reasons about a ticket that was never dispatched.
  {
    const all = f.tstore.load(f.team.root);
    for (const x of all) if (!x.taskDir) x.taskDir = `tasks/${x.id}-fixture/SPEC.md`;
    f.tstore.save(f.team.root, all);
  }
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'start', id: 't1', who: null, body: '' });
  const t = f.one('t1');
  assert.ok(t, 'ENTER: the ticket exists on the board');
  assert.ok(t.startedAt, 'ENTER: start really dispatched it — `add` alone satisfies the check above');
  f.gated.length = 0;
  return t;
}


// The stamp `_taskDone` writes when it closes a loop-eligible ticket: state
// `done` plus `loopStep: 'verify'`, in one save, before `_runTicketLoop` runs.
// Written directly rather than driven through `_taskDone` because that handler
// fires the loop, which shells out to git — and the subject here is the board
// STATE the guard reads, not how it got there. If the field ever moved, every
// refusal test below fails loudly rather than going quiet: they assert a refusal
// that only a non-empty verify set can produce.
function intoVerify(f, id) {
  const all = f.tstore.load(f.team.root);
  const t = all.find((x) => x.id === id);
  assert.ok(t, `ENTER: ${id} must be on the board before it can be stamped`);
  t.state = 'done';
  t.loopStep = 'verify';
  f.tstore.save(f.team.root, all);
  const back = f.one(id);
  // The fixture is only useful if it round-trips through the SAME resolution the
  // code under test uses. A write to the wrong path reads back as undefined here
  // instead of surfacing 40 lines later as a mysterious spawn.
  assert.strictEqual(back && back.loopStep, 'verify',
    'ENTER: the stamp must be readable back through ticketsStore.load(team.root) — the store resolves '
    + 'through projectDirFor(home, root), and a fixture on the wrong path reads back as an empty board');
  return back;
}

// Every reply _handleTeamReview made, and the seat records it reserved. A spawn
// IS a reservation here (`m.create` is stubbed), so "no seat spawned" is
// "no new persistence record" — asserted, because a refusal that still spawned
// would be cosmetic and the message alone cannot tell the two apart.
function callReview(f, scope, opts) {
  const before = new Set(f.persistence.list().map((e) => e.name));
  f.injected.length = 0;
  f.m._handleTeamReview(f.seat('lead'), scope, opts);
  const spawned = f.persistence.list().filter((e) => !before.has(e.name));
  return { spawned, replies: [...f.injected] };
}

// ── the refusal ────────────────────────────────────────────────────────────

test('a bare team-review is refused while a ticket is in verify, and NO seat spawns', () => {
  const f = mkFixture();
  openTicket(f);
  intoVerify(f, 't1');

  const r = callReview(f, 'review the diff on t1');

  assert.deepStrictEqual(r.spawned, [],
    'a refusal that still reserved a seat is cosmetic — the unattached reviewer is the whole defect');
  assert.strictEqual(r.replies.length, 1, 'ENTER: exactly one reply, or the assertions below read the wrong string');
  const msg = r.replies[0];
  assert.match(msg, /^\[agent:team-review\] error:/, 'it must refuse, not warn and proceed');
  // The id is the fixture-visibility proof: an empty board cannot name t1, and an
  // empty board is exactly what a mis-pathed fixture produces silently.
  assert.match(msg, /\bt1\b/, 'the refusal must name the ticket in verify — and an empty board could not');
  assert.match(msg, /task reject/,
    'and point at the right alternative: another round on a reviewed ticket is a reject with must-fixes');
});

test('the refusal names EVERY ticket in verify, not just the first', () => {
  const f = mkFixture();
  openTicket(f);
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'second spec' });
  assert.ok(f.one('t2'), 'ENTER: a second ticket exists, or this test is the single-ticket case again');
  intoVerify(f, 't1');
  intoVerify(f, 't2');

  const r = callReview(f, 'review something');

  assert.deepStrictEqual(r.spawned, []);
  const msg = r.replies[0] || '';
  assert.match(msg, /\bt1\b/);
  assert.match(msg, /\bt2\b/, 'a lead told about one of two in-flight tickets still cannot tell which review is theirs');
});

// ── the deadlock case: the most important subject in this file ─────────────
//
// The loop's reviewer is spawned FROM `verify`, through this same handler. If
// the guard did not check `reviewTicket` first it would refuse here, and every
// ticket in the system would stall at review forever.

test("the loop's own call is NOT refused for a ticket in verify", () => {
  const f = mkFixture();
  openTicket(f);
  const t = intoVerify(f, 't1');
  assert.strictEqual(t.loopStep, 'verify',
    'ENTER: the ticket really is in the state the guard refuses on — otherwise this passes vacuously '
    + 'and the deadlock it exists to catch ships');

  const r = callReview(f, 'review the diff at /tmp/t1.diff', { ticketId: 't1' });

  assert.strictEqual(r.spawned.length, 1,
    'the loop MUST still spawn from verify — a guard that refuses here deadlocks verify against itself '
    + 'and no ticket ever reaches review again');
  // Whole-object per CLAUDE.md: a field-by-field match reads around a seed the
  // guard's early return could have skipped, and losing reviewTicket is exactly
  // the "verdict lands nowhere" this ticket is about.
  assert.deepStrictEqual(r.spawned[0], {
    name: 'team-reviewer-1-r1', ephemeral: true, reviewFor: 'lead', reviewTicket: 't1',
    wireLabel: 'team.t1.review-r1',
  });
  assert.ok(!r.replies.some((m) => /^\[agent:team-review\] error:/.test(m)),
    'and it must not even warn — the loop turns an error reply into an escalation');
});

test("the loop's call for ONE ticket is not refused by a DIFFERENT ticket in verify", () => {
  const f = mkFixture();
  openTicket(f);
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'second spec' });
  intoVerify(f, 't1');
  const other = intoVerify(f, 't2');
  assert.strictEqual(other.loopStep, 'verify', 'ENTER: a second, unrelated ticket is also in verify');

  const r = callReview(f, 'review t1', { ticketId: 't1' });

  assert.strictEqual(r.spawned.length, 1,
    'the scope is `!reviewTicket`, not "this ticket" — two hands finishing at once must not block each other');
  assert.strictEqual(r.spawned[0].reviewTicket, 't1');
});

// ── the guard must not have deleted the intent ─────────────────────────────

test('a bare team-review still spawns normally when nothing is in verify', () => {
  const f = mkFixture();
  openTicket(f);
  const board = f.tstore.load(f.team.root);
  assert.ok(board.length, 'ENTER: the board is NOT empty — a guard tested against an empty board proves nothing');
  assert.ok(board.every((t) => t.loopStep !== 'verify'), 'ENTER: and nothing on it is in verify');

  const r = callReview(f, 'review the boot-race fix');

  assert.strictEqual(r.spawned.length, 1,
    'team-review is the documented escape hatch for when the loop CANNOT spawn a reviewer — a guard that '
    + 'always refuses has deleted the intent rather than timed it');
  assert.strictEqual(r.spawned[0].name, 'team-reviewer-1');
  assert.strictEqual(r.spawned[0].reviewTicket, undefined, 'and it is still unattached, as an ad-hoc review is');
});

test('a ticket in the REVIEW step does not refuse a bare call — only verify does', () => {
  const f = mkFixture();
  openTicket(f);
  const all = f.tstore.load(f.team.root);
  const t = all.find((x) => x.id === 't1');
  t.state = 'done';
  t.loopStep = 'review';
  f.tstore.save(f.team.root, all);
  assert.strictEqual(f.one('t1').loopStep, 'review', 'ENTER: the ticket is at review, not verify');

  const r = callReview(f, 'review something else');

  assert.strictEqual(r.spawned.length, 1,
    "a `review` ticket already has its seat on the roster, so the lead can see the redundancy — `verify` is "
    + 'the blind window, and widening the guard past it would refuse the escape hatch on a stuck review');
});

// ── the ordering: authority before board state ─────────────────────────────

test('a non-lead gets the authority error, never a board-state error naming tickets', () => {
  const f = mkFixture();
  openTicket(f);
  intoVerify(f, 't1');
  f.injected.length = 0;

  f.m._handleTeamReview(f.seat('team-hand'), 'let me review this');

  assert.strictEqual(f.injected.length, 1, 'ENTER: the non-lead call was answered at all');
  assert.match(f.injected[0], /only the team lead \(lead\) can request a review/);
  assert.ok(!/\bt1\b/.test(f.injected[0]),
    'the guard sits AFTER the lead gate: an unauthorized caller must not learn ticket ids from a refusal');
});
