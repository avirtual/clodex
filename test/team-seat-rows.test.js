'use strict';

// t426 A3 — the session list row carries the manifest ROLE its seat holds.
//
// The renderer's role summaries count seats per role and could not previously do
// it: matchSeatRole short-circuits on the lead pointer, strips an `-r<N>` review
// tail then a numeric one, and guards its lookup with hasOwnProperty. A renderer
// copy of that would be a second implementation in a second process, so the row
// carries the answer instead — and these tests exercise the REAL matchSeatRole
// through the manager (it is a module import in session-manager, not a seam), so
// they pin the row against the resolution the backend actually uses.

const { test } = require('node:test');
const assert = require('node:assert');

const { createSessionManager } = require('../session-manager');

const TEAM = {
  name: 'shop', root: '/proj', lead: 'boss', watchdogMs: null, file: '/tmp/team.json',
  roles: {
    lead: { brief: 'the lead' },
    hand: { brief: 'the hand' },
    reviewer: { brief: 'the reviewer' },
  },
};

// Sessions land in the manager's live map directly: create() is a spawn path and
// this is about list()'s projection, not about spawning.
function mkRows(seats, { resolveTeam = (cwd) => (cwd === '/proj' ? TEAM : null) } = {}) {
  const SessionManager = createSessionManager({
    getRemoteServer: () => null,
    getUiSettings: () => ({ get: () => ({}) }),
    getPersistence: () => ({ list: () => [], get: () => null }),
    notifyOS: () => {},
    log: { info() {}, warn() {}, error() {}, debug() {} },
    fs: require('node:fs'),
    countPending: () => 0,
    resolveTeam,
    findProjectRoot: (cwd) => (cwd === '/proj' ? '/proj' : null),
    // No tickets store: openTicketFor's own try/catch answers null, which is what
    // every row here wants. `role` must resolve independently of it.
  });
  const m = new SessionManager();
  for (const s of seats) {
    m.sessions.set(s.name, {
      type: 'claude', agentType: 'claude', cwd: '/proj', pty: { pid: 1 },
      activityState: 'idle', ...s,
    });
  }
  return Object.fromEntries(m.list().map((r) => [r.name, r]));
}

test('list(): an agent seat named for a role carries that role', () => {
  const rows = mkRows([{ name: 'shop-hand' }, { name: 'shop-hand-2' }, { name: 'shop-reviewer' }]);
  assert.strictEqual(rows['shop-hand'].role, 'hand');
  // The numbered form is how several seats of one role are made, and it must
  // decompose — a role listing that missed them would undercount every real team.
  assert.strictEqual(rows['shop-hand-2'].role, 'hand', 'the numeric tail strips');
  assert.strictEqual(rows['shop-reviewer'].role, 'reviewer');
});

test('list(): the LEAD seat resolves through the team pointer, not through its name', () => {
  // `boss` follows no `<team>-<role>` convention at all — the normal case for a
  // lead, and the reason the renderer cannot match on names alone.
  const rows = mkRows([{ name: 'boss' }]);
  assert.strictEqual(rows['boss'].role, 'lead');
});

test('list(): a ticket reviewer seat strips BOTH tails to `reviewer`', () => {
  // `<team>-reviewer-<ticket>-r<round>`: the round tail goes first, then the
  // ticket number. A seat this cannot decompose holds no role at all.
  const rows = mkRows([{ name: 'shop-reviewer-42-r2' }]);
  assert.strictEqual(rows['shop-reviewer-42-r2'].role, 'reviewer');
});

test('list(): a BASH session is null by construction, even if its name matches a role', () => {
  const rows = mkRows([
    { name: 'shop-hand', agentType: null, type: 'bash' },
    // ENTER: the same name as an AGENT does resolve, so the null above is about
    // the session type and not about a fixture that resolves nothing.
    { name: 'shop-reviewer' },
  ]);
  assert.strictEqual(rows['shop-hand'].role, null, 'a bash session has no registry entry and holds no role');
  assert.strictEqual(rows['shop-reviewer'].role, 'reviewer', 'ENTER: an agent seat still resolves');
});

test('list(): a name that decomposes to no role is null, never guessed', () => {
  const rows = mkRows([
    { name: 'shop-hand-wire' },     // non-numeric tail names a different thing
    { name: 'shop-toString' },      // prototype walk, if the lookup used `in`
    { name: 'elsewhere-hand' },     // wrong team prefix
    { name: 'shop-hand' },          // ENTER
  ]);
  assert.strictEqual(rows['shop-hand-wire'].role, null, 'a lettered tail is not waved through to `hand`');
  assert.strictEqual(rows['shop-toString'].role, null, 'Object.prototype is not a role table');
  assert.strictEqual(rows['elsewhere-hand'].role, null, 'another team\'s prefix resolves to nothing here');
  assert.strictEqual(rows['shop-hand'].role, 'hand', 'ENTER: the fixture does resolve a real seat');
});

test('list(): a seat outside any team carries a null role, not a throw', () => {
  const rows = mkRows([{ name: 'shop-hand', cwd: '/elsewhere' }]);
  assert.strictEqual(rows['shop-hand'].role, null);
  assert.strictEqual(rows['shop-hand'].team, null, 'and no team either — same resolution');
});

test('list(): a resolveTeam that THROWS leaves the row null rather than failing the listing', () => {
  // The sidebar's whole listing hangs off this call. A team.json that is corrupt
  // or mid-write must cost one null field, not every row in the window.
  const rows = mkRows([{ name: 'shop-hand' }], {
    resolveTeam: () => { throw new Error('team.json is garbage'); },
  });
  assert.strictEqual(rows['shop-hand'].role, null);
});

test('list(): every row of a listing reads ONE team snapshot — role, team and badge cannot disagree', () => {
  // `role`, `team` and the ticket badge each need the manifest, and all three go
  // through the listing's per-cwd memo. So a manifest that changes (or becomes
  // unreadable) partway through a listing cannot give the badge one answer and
  // the row another: after the first resolution nothing re-reads it.
  //
  // Counting calls is NOT the instrument here — `_projectRootFor` resolves the
  // team again for its own reasons, once per seat, so a call count measures that
  // and not this. Making every resolution AFTER the first throw is what isolates
  // the row projection: if any part of it re-resolved, the row would go null.
  let n = 0;
  const rows = mkRows([{ name: 'shop-hand' }, { name: 'shop-reviewer' }], {
    resolveTeam: (cwd) => {
      n += 1;
      if (n > 1) throw new Error('team.json vanished mid-listing');
      return cwd === '/proj' ? TEAM : null;
    },
  });
  assert.ok(n > 1, 'ENTER: the listing did resolve more than once, or this pins nothing');
  assert.strictEqual(rows['shop-hand'].role, 'hand', 'the first row resolved');
  assert.strictEqual(rows['shop-reviewer'].role, 'reviewer', 'and so did the second, off the same snapshot');
  assert.strictEqual(rows['shop-reviewer'].team, 'shop', 'team agrees with role — same resolution');
});
