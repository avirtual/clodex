// Run: node --test
// The wiring half of the cost attribution: that the wire label actually reaches
// the persistence record BEFORE the deferred create() reads it back, and that
// closing a ticket writes COST.json into its task dir.
//
// Both are ordering/plumbing properties, not computations — team-cost.test.js
// covers the shapes. What can silently break here is the ORDER (a label written
// after create() labels nothing) and the close hook simply never firing, and
// neither is visible from inside team-cost.js.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createSessionManager } = require('../session-manager');
const { resolveProxyAgentId } = require('../proxy-util');

// A persistence double that behaves like the real store on the two operations
// the labeling path uses: upsert spread-merges, get returns the merged entry.
function mkPersistence(seed = []) {
  const rows = seed.slice();
  return {
    rows,
    list: () => rows,
    get: (name) => rows.find((r) => r.name === name) || null,
    upsert(entry) {
      const i = rows.findIndex((r) => r.name === entry.name);
      if (i >= 0) rows[i] = { ...rows[i], ...entry };
      else rows.push({ ...entry });
    },
    remove(name) {
      const i = rows.findIndex((r) => r.name === name);
      if (i >= 0) rows.splice(i, 1);
    },
  };
}

function mkManager(overrides = {}) {
  const persistence = overrides.persistence || mkPersistence();
  const deps = {
    // A temp HOME and registry, never the operator's ~/.clodex: this test drives
    // the code that CREATES a task dir, so a real REGISTRY_DIR would scatter
    // fixture task dirs through the operator's own project artifacts.
    REGISTRY_DIR: overrides.registryDir,
    os: { ...os, homedir: () => overrides.home || os.homedir() },
    getRemoteServer: () => null,
    getUiSettings: () => ({ get: () => ({}) }),
    getPersistence: () => persistence,
    notifyOS: () => {},
    fs,
    path,
    ensureDir: (d) => fs.mkdirSync(d, { recursive: true }),
    getUserDataPath: () => overrides.userData,
    log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    spillToFile: () => '/tmp/spill-stub.txt',
    MSG_MAX_AGE: 1800,
    intentEnabled: require('../intent-catalog').intentEnabled,
    withoutPrivilegedIntentsFor: require('../intent-registry').withoutPrivilegedIntentsFor,
    fencedLines: require('../intent-scanner').fencedLines,
    bodyModeFor: require('../intent-registry').bodyModeFor,
    intentEnabledFor: require('../intent-registry').intentEnabledFor,
    pluginRowFor: require('../intent-registry').pluginRowFor,
    validIntentNames: require('../intent-registry').validIntentNames,
    countPending: require('../pending-store').countPending,
    isDraftOpen: require('../proxy-util').isDraftOpen,
    drainPending: require('../pending-store').drainPending,
    hasActivePending: require('../pending-store').hasActivePending,
    termAvailableFor: require('../drawer-avail').termAvailableFor,
    gitWorktree: overrides.gitWorktree || {
      listWorktrees: async () => ({ ok: true, repo: '/proj', worktrees: [] }),
      commitsOnBranch: async () => ({ ok: true, count: 0 }),
    },
    ...(overrides.deps || {}),
  };
  const SessionManager = createSessionManager(deps);
  const m = new SessionManager();
  m._broadcast = () => {};
  m._sendToSession = () => {};
  m._injectText = () => {};
  return { m, persistence };
}

const settle = () => new Promise((r) => setImmediate(() => setImmediate(r)));

test('a labelled record mints a ticket-keyed proxy agent id; an unlabelled one keeps its name', () => {
  const persistence = mkPersistence();
  persistence.upsert({ name: 'team-hand-7', ephemeral: true, wireLabel: 'team.t7.hand' });

  const entry = persistence.get('team-hand-7');
  const labelFrom = (entry && entry.wireLabel) || 'team-hand-7';
  const id = resolveProxyAgentId({ name: labelFrom, fork: false, existing: entry, taken: new Set(), rand: () => 'deadbeef' });
  assert.strictEqual(id, 'clodex-team.t7.hand-deadbeef');

  // A seat with no label falls back to its name — every non-team session.
  const plain = mkPersistence([{ name: 'solo' }]).get('solo');
  const plainLabel = (plain && plain.wireLabel) || 'solo';
  assert.strictEqual(
    resolveProxyAgentId({ name: plainLabel, fork: false, existing: plain, taken: new Set(), rand: () => 'deadbeef' }),
    'clodex-solo-deadbeef');
});

// The test above models the lookup; it does NOT prove create() performs it, and
// on its own it passes against a tree where nothing was wired (it did, first
// run). The ordering contract lives in source: the label must be read from the
// record at the mint, and written to the record BEFORE the deferred create()
// that reads it. Both are one-line properties invisible to a unit test that
// cannot spawn a PTY, so they are pinned here the way create-mint-census.js
// pins its call sites — against the source.
test('create() mints from the record label, and both spawn paths seed it before create()', () => {
  // The contract now spans BOTH halves of the t380 split, and the two halves
  // are read separately rather than concatenated: create() and ALWAYS_PRESERVE
  // are core, the two spawn paths are ticket machinery. Concatenating would let
  // an anchor satisfy itself from the wrong file — including the seed-BEFORE-
  // create ordering in part 2, which is a position comparison and would then be
  // measuring an offset across a file boundary.
  const src = fs.readFileSync(path.join(__dirname, '..', 'session-manager.js'), 'utf8');
  const ticketSrc = fs.readFileSync(path.join(__dirname, '..', 'team-tickets.js'), 'utf8');

  // 1. The mint reads the label off the record rather than taking the raw name.
  assert.match(src, /const labelFrom = \(existingEntry && existingEntry\.wireLabel\) \|\| name;/,
    'create() must derive the proxy agent id from the record label');
  assert.match(src, /resolveProxyAgentId\(\{ name: labelFrom,/,
    'the minted id must come from labelFrom, not from name');

  // 2. Both team spawn paths seed wireLabel on the SYNCHRONOUS pre-create stub.
  // A seed placed after the deferred create() would label nothing at all.
  //
  // This is a SOURCE CENSUS, like create-mint-census.js: the regexes below are
  // deliberately literal and a reformat of those lines breaks them. That is the
  // point — the property is an ordering in the source that no runnable unit test
  // can observe without spawning a PTY. Re-anchor it on the moved code; do NOT
  // loosen the pattern until it passes, which retires the check silently.
  const seeds = ticketSrc.match(/wireLabel: \w+ \}/g) || [];
  assert.strictEqual(seeds.length, 2,
    `expected exactly 2 wireLabel seeds (reviewer + ticket seat), found ${seeds.length}`);
  // ENTER: and none stayed behind in core, which would mean the move split a
  // spawn path in half rather than carrying it across.
  assert.strictEqual((src.match(/wireLabel: \w+ \}/g) || []).length, 0,
    'a wireLabel seed is still in session-manager.js — both spawn paths moved to team-tickets.js');

  for (const [label, seedRe, createRe] of [
    // t308 put `reviewTicket` on this same stub, between the two anchored lines.
    // Re-anchored THROUGH it rather than gap-matched: the property is that the
    // seed rides the reviewFor upsert specifically, and a `[\s\S]*?` bridge would
    // also accept a wireLabel seeded on some other nearby object.
    ['reviewer', /reviewFor: session\.name,\n(?:\s*\/\/[^\n]*\n)*\s*\.\.\.\(reviewTicket \? \{ reviewTicket \} : \{\}\),\n\s*\.\.\.\(reviewLabel \?/, /name, type, cwd, shape\.extraArgs, null, shape\.workspaceId,/],
    ['ticket seat', /name: seat\.name, ephemeral: true,\n\s*\.\.\.\(seatLabel \?/, /seat\.name, shape\.type, shape\.cwd,/],
  ]) {
    const seedAt = ticketSrc.search(seedRe);
    const createAt = ticketSrc.search(createRe);
    // ENTER: both anchors were actually found. A -1 from either search would
    // make the ordering comparison below true for the wrong reason.
    assert.ok(seedAt > 0, `${label}: the wireLabel seed must be present`);
    assert.ok(createAt > 0, `${label}: the create() call must be present`);
    assert.ok(seedAt < createAt,
      `${label}: wireLabel must be seeded BEFORE create(), or the mint reads an unlabelled record`);
  }

  // 3. And it must survive an in-place restart. Seeded only at the mint, with
  // nothing to regrow it, a label dropped by kill()+create() sends the seat's
  // whole remaining spend to an unlabeled route while the ticket reads as free.
  // preserve-across-restart.test.js then covers the call sites by construction.
  assert.match(src, /const ALWAYS_PRESERVE = \[[^\]]*'wireLabel'/,
    'wireLabel must be in ALWAYS_PRESERVE, or every restart un-attributes the seat');
});

// The taskDir shapes REAL tickets carry: relative and tilde-prefixed pointers
// dominate the live store, so the field arrives in whatever shape the writing
// agent used and is resolved, never trusted. A fixture passing an mkdtemp path
// (as this one first did) tests the shape that is LEAST like what tickets carry,
// and passes over a writer that mkdir -p's a literal `~` under the process cwd.
//
// The resolution target is derived the way the CODE derives it — same
// clodex-paths function, same injected registry root — rather than hardcoded: a
// literal here would pass while the code placed the artifact somewhere else
// entirely, which is the bug being fixed.
const { projectDirFor } = require('../clodex-paths');

// One temp HOME per test, so nothing touches the operator's ~/.clodex.
function mkHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'clodex-home-'));
  return { home, registryDir: path.join(home, '.clodex') };
}

const LEDGER = {
  version: 1,
  sessions: {
    's1': { cost: 3.5, requests: 40, turns: 9, refusals: 0, inputTokens: 500, outputTokens: 200, cacheReadTokens: 9500, cacheWriteTokens: 0 },
  },
};

for (const [shape, taskDirOf] of [
  ['tilde-prefixed', (proj, name, home) => path.join('~', path.relative(home, proj), 'tasks', name)],
  ['bare relative', (_proj, name) => `tasks/${name}`],
  ['a spec FILE, not a dir', (_proj, name) => `tasks/${name}/SPEC.md`],
]) {
  test(`closing a ticket writes COST.json into the RESOLVED task dir (${shape})`, async () => {
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'clodex-ud-'));
    fs.writeFileSync(path.join(userData, 'wire-totals.json'), JSON.stringify(LEDGER));
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'clodex-repo-'));
    const { home, registryDir } = mkHome();
    const taskName = `t293-fixture-${shape.replace(/[^a-z]+/gi, '-')}`;
    // Where the code must put it — under the projects root for this repo.
    const resolved = path.join(projectDirFor(registryDir, repo), 'tasks', taskName);

    const persistence = mkPersistence([{
      name: 'team-hand-7', sessionId: 's1', wireLabel: 'team.t7.hand',
      worktree: { path: '/tmp/wt-7', branch: 't7' },
    }]);
    const { m } = mkManager({
      persistence, userData, home, registryDir,
      gitWorktree: {
        listWorktrees: async () => ({ ok: true, repo, worktrees: [
          { path: repo, branch: 'master', isMain: true },
          { path: '/tmp/wt-7', branch: 't7' },
        ] }),
        commitsOnBranch: async () => ({ ok: true, count: 4, base: 'ba5e' }),
      },
    });
    // The seat is name-assigned here, so _ticketAssigneeSeat's role lookup is not
    // in play; the role case has its own test below.
    m._teamLiveSeatNames = () => ['team-hand-7'];

    m._writeTicketCost({ name: 'team', root: repo }, {
      id: 't7', role: 'hand', assignee: 'team-hand-7', state: 'done',
      taskDir: taskDirOf(projectDirFor(registryDir, repo), taskName, home),
      openedAt: 1000, closedAt: 61000,
      worktree: { path: '/tmp/wt-7', branch: 't7', baseSha: 'ba5e' },
    });
    await settle();

    const written = path.join(resolved, 'COST.json');
    // ENTER: the artifact landed at the RESOLVED path. Everything below reads
    // that file, so a write that went somewhere else (a literal `~` tree under
    // cwd — the actual bug) would fail here rather than silently.
    assert.ok(fs.existsSync(written), `COST.json must exist at ${written}`);
    const rec = JSON.parse(fs.readFileSync(written, 'utf8'));
    // Read end-to-end through the real ledger file rather than from a stub: a
    // broken read degrades to zeros, which a shape-only assertion accepts.
    assert.strictEqual(rec.ticket, 't7');
    assert.strictEqual(rec.wireLabel, 'team.t7.hand');
    assert.strictEqual(rec.usd, 3.5);
    assert.strictEqual(rec.wallMs, 60000);
    assert.deepStrictEqual(rec.tokens, {
      input: 500, output: 200, cacheRead: 9500, cacheWrite: 0, cachedFraction: 0.95,
    });
    assert.deepStrictEqual(rec.waste, {
      worktreeMinted: true, commits: 4, zeroCommit: false, commitsBase: 'ba5e',
      orphanedCheckouts: 0, unclaimedNonMain: 0, claimedByArchived: 0,
    });

    fs.rmSync(userData, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  });
}

// A ticket assigned to a ROLE keeps `assignee: 'hand'`, and nothing is stored
// under a role name — only the worktree-seat path re-pins the assignee to a
// seat. The obvious resolution, scanning live seats for one holding the role,
// returns whichever seat the sessions map yields FIRST: on a team with three
// live hands (the normal case, not an edge) that is a coin flip, and the
// artifact stamped it `seatResolved: true`. A guessed seat is strictly worse
// than no seat — it publishes a foreign lifetime ledger, a foreign wireLabel,
// and through the record's own `worktree` a foreign BRANCH's commit count, none
// of which anything downstream can tell from a measurement.
//
// So the resolution is ordered and NARROW, and the mode is recorded:
//   'seat'        — assignee names a persistence record. Exact.
//   'role-closer' — assignee is a role and the closer holds that role.
//   'unknown'     — everything else. No guessed seat, null ledger.
const ROLE_LEDGER = {
  version: 1,
  sessions: {
    'sess-hand-1': { cost: 11, requests: 1, turns: 1, refusals: 0, inputTokens: 11, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
    'sess-hand-2': { cost: 22, requests: 2, turns: 2, refusals: 0, inputTokens: 22, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
    'sess-lead': { cost: 9999, requests: 9, turns: 9, refusals: 0, inputTokens: 99, outputTokens: 9, cacheReadTokens: 0, cacheWriteTokens: 0 },
  },
};

// Three live hands and a lead, which is what this repo's own team looks like.
const ROLE_SEATS = [
  { name: 'team-hand-1', sessionId: 'sess-hand-1', wireLabel: 'team.t99.hand' },
  { name: 'team-hand-2', sessionId: 'sess-hand-2', wireLabel: 'team.t50.hand' },
  { name: 'team-hand-3' },
  { name: 'team-lead', sessionId: 'sess-lead' },
];

function mkRoleRig(seats = ROLE_SEATS, gitWorktree = undefined) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'clodex-ud-'));
  fs.writeFileSync(path.join(userData, 'wire-totals.json'), JSON.stringify(ROLE_LEDGER));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'clodex-repo-'));
  const { home, registryDir } = mkHome();
  const persistence = mkPersistence(seats);
  const { m } = mkManager({ persistence, userData, home, registryDir, gitWorktree });
  m._teamLiveSeatNames = () => seats.map((s) => s.name);
  return {
    m,
    team: { name: 'team', root: repo, lead: 'team-lead', roles: { lead: {}, hand: {} } },
    read: (taskName) => JSON.parse(fs.readFileSync(
      path.join(projectDirFor(registryDir, repo), 'tasks', taskName, 'COST.json'), 'utf8')),
    cleanup: () => { for (const d of [userData, repo, home]) fs.rmSync(d, { recursive: true, force: true }); },
  };
}

test('a role ticket does not bill whichever seat holds the role first', async () => {
  const rig = mkRoleRig();
  rig.m._writeTicketCost(rig.team, {
    id: 't20', role: 'hand', assignee: 'hand', state: 'done',
    taskDir: 'tasks/role-many-seats', openedAt: 1, closedAt: 2,
  });
  await settle();
  const rec = rig.read('role-many-seats');
  // ENTER: the artifact was written at all. Every assertion below is an
  // absence, and all of them are vacuously true of a file that never landed.
  assert.strictEqual(rec.ticket, 't20');
  assert.deepStrictEqual(
    [rec.sessions.attribution, rec.sessions.seatResolved, rec.seat, rec.wireLabel, rec.usd],
    ['unknown', false, null, null, null],
    'three live hands is a coin flip: name no seat and measure nothing');
  rig.cleanup();
});

test('the lead\'s lifetime ledger never lands on a ticket — under EITHER role', async () => {
  // The rejected fix was "prefer ticket.closedBy". `_taskCancel` is lead-only,
  // and the lead can also close a `task done` on behalf of a seat that no longer
  // can — so closedBy is frequently the lead, whose record is the largest ledger
  // in the system. Taking it verbatim swaps a hand's spend for the lead's whole
  // life. closedBy counts only when the closer HOLDS the ticket's role.
  //
  // Both assignee shapes, because the role-closer guard alone does NOT cover the
  // second: `matchSeatRole(team, team.lead)` returns 'lead' unconditionally, so a
  // ticket assigned to the `lead` ROLE and closed by the lead satisfies the guard
  // exactly and publishes the whole lifetime. The title used to claim this while
  // only exercising `assignee: 'hand'`.
  const rig = mkRoleRig();
  for (const [id, assignee, taskName] of [
    ['t21', 'hand', 'role-closed-by-lead'],
    ['t26', 'lead', 'lead-role-closed-by-lead'],
  ]) {
    rig.m._writeTicketCost(rig.team, {
      id, role: assignee, assignee, state: 'done', closedBy: 'team-lead',
      taskDir: `tasks/${taskName}`, openedAt: 1, closedAt: 2,
    });
    await settle();
    const rec = rig.read(taskName);
    assert.strictEqual(rec.ticket, id);   // ENTER, as above
    assert.deepStrictEqual([rec.sessions.attribution, rec.seat, rec.usd], ['unknown', null, null],
      `assignee '${assignee}' closed by the lead must not resolve`);
    assert.notStrictEqual(rec.usd, 9999, "the lead's lifetime ledger is not this ticket's cost");
  }
  rig.cleanup();
});

test('a closer who is not the seat the ticket was DELIVERED to resolves to nothing', async () => {
  // Any role-holder may close any ticket of that role, so hand-3 closing hand-1's
  // ticket otherwise stamps hand-3's ledger `seatResolved: true`. `deliveredTo`
  // is used as a FALSIFIER only: present and disagreeing, it kills the
  // inference; absent, it says nothing either way. The field is a late addition
  // that most closed tickets predate, so treating its absence as evidence would
  // unknown-out the ones that carry the most history.
  const rig = mkRoleRig();
  rig.m._writeTicketCost(rig.team, {
    id: 't27', role: 'hand', assignee: 'hand', state: 'done', closedBy: 'team-hand-2',
    deliveredTo: { seat: 'team-hand-1', incarnation: 3, at: 5 },
    taskDir: 'tasks/closer-not-delivered', openedAt: 1, closedAt: 2,
  });
  await settle();
  const rec = rig.read('closer-not-delivered');
  assert.strictEqual(rec.ticket, 't27');   // ENTER, as above
  assert.deepStrictEqual([rec.sessions.attribution, rec.seat, rec.usd], ['unknown', null, null],
    'hand-2 closed a ticket delivered to hand-1 — that is not evidence of who spent');

  // Agreeing, it is the same inference as before: still role-closer, not better.
  rig.m._writeTicketCost(rig.team, {
    id: 't28', role: 'hand', assignee: 'hand', state: 'done', closedBy: 'team-hand-2',
    deliveredTo: { seat: 'team-hand-2', incarnation: 1, at: 5 },
    taskDir: 'tasks/closer-is-delivered', openedAt: 1, closedAt: 2,
  });
  await settle();
  const agree = rig.read('closer-is-delivered');
  assert.deepStrictEqual([agree.sessions.attribution, agree.seat, agree.usd],
    ['role-closer', 'team-hand-2', 22], 'a corroborating deliveredTo must not block the inference');
  rig.cleanup();
});

// t295 made `assignee` a delivery-time PIN, which is exact evidence only while it
// names the seat that worked. A pinned seat that dies degrades the ticket back to
// its role, and a sibling holding that role may then close it — so the pin names
// one seat while another did the work. The seat branch has no `deliveredTo`
// falsifier, so this is the guard that keeps a dead seat's ledger off a
// sibling's ticket.
test('a pinned seat that did not close, and a sibling of its role that did, resolve to nothing', async () => {
  const rig = mkRoleRig();
  rig.m._writeTicketCost(rig.team, {
    id: 't29', role: 'hand', assignee: 'team-hand-1', state: 'done', closedBy: 'team-hand-2',
    taskDir: 'tasks/pin-inherited', openedAt: 1, closedAt: 2,
  });
  await settle();
  const rec = rig.read('pin-inherited');
  assert.strictEqual(rec.ticket, 't29');   // ENTER, as above
  assert.deepStrictEqual([rec.sessions.attribution, rec.seat, rec.usd], ['unknown', null, null],
    'hand-1 holds the pin but hand-2 closed it — billing the pin publishes a dead seat\'s ledger under another\'s work');
  assert.notStrictEqual(rec.usd, 11, "the pinned seat's ledger is not this ticket's cost");

  // The CONTROL: the pinned seat closing its OWN ticket is still exact. Without
  // it the assertion above is satisfied by a tree that resolves nothing at all.
  rig.m._writeTicketCost(rig.team, {
    id: 't30', role: 'hand', assignee: 'team-hand-1', state: 'done', closedBy: 'team-hand-1',
    taskDir: 'tasks/pin-own', openedAt: 1, closedAt: 2,
  });
  await settle();
  const own = rig.read('pin-own');
  assert.deepStrictEqual([own.sessions.attribution, own.seat, own.usd], ['seat', 'team-hand-1', 11],
    'the seat that holds the pin and closed it is exactly attributable');
  rig.cleanup();
});

// The closer test above cannot see this one: closing on a seat's behalf is the
// LEAD's dominant habit, and a lead closer short-circuits it. Replay hands a
// degraded ticket to a sibling and stamps `deliveredTo` WITHOUT re-pinning, so
// the record can name a dead seat while another did the work — and the lead then
// closes it. Without the falsifier that publishes the dead seat's lifetime ledger
// and wireLabel with `seatResolved: true`.
test('a pin contradicted by deliveredTo resolves to nothing, even when the LEAD closes', async () => {
  const rig = mkRoleRig();
  rig.m._writeTicketCost(rig.team, {
    id: 't31', role: 'hand', assignee: 'team-hand-1', state: 'done', closedBy: 'team-lead',
    deliveredTo: { seat: 'team-hand-2', incarnation: 1, at: 5 },
    taskDir: 'tasks/pin-vs-delivered', openedAt: 1, closedAt: 2,
  });
  await settle();
  const rec = rig.read('pin-vs-delivered');
  assert.strictEqual(rec.ticket, 't31');   // ENTER, as above
  assert.deepStrictEqual([rec.sessions.attribution, rec.seat, rec.usd], ['unknown', null, null],
    'the spec went to hand-2 while the pin says hand-1 — the pin is not evidence of who spent');
  assert.notStrictEqual(rec.usd, 11, "the pinned seat's ledger is not this ticket's cost");

  // The CONTROL: a CORROBORATING deliveredTo must not block an exact pin, or the
  // falsifier would unknown-out every replayed ticket that was never inherited.
  rig.m._writeTicketCost(rig.team, {
    id: 't32', role: 'hand', assignee: 'team-hand-1', state: 'done', closedBy: 'team-lead',
    deliveredTo: { seat: 'team-hand-1', incarnation: 1, at: 5 },
    taskDir: 'tasks/pin-agrees', openedAt: 1, closedAt: 2,
  });
  await settle();
  const agree = rig.read('pin-agrees');
  assert.deepStrictEqual([agree.sessions.attribution, agree.seat, agree.usd], ['seat', 'team-hand-1', 11],
    'an agreeing deliveredTo leaves the exact pin exact');
  rig.cleanup();
});

test('a role ticket inherits no worktree from a seat that is working another ticket', async () => {
  // The worktree is gated INDEPENDENTLY of the ledger: it comes from the
  // persistence record, so a guessed seat mid-way through some other ticket
  // reports worktreeMinted:true and a commit count taken on that other branch.
  // A role ticket that never had a tree must read exactly as it did before this
  // change — not minted.
  const seats = ROLE_SEATS.map((s) => (s.name === 'team-hand-1'
    ? { ...s, worktree: { path: '/tmp/wt-t99', branch: 't99', baseSha: 'ba5e' } } : s));
  const rig = mkRoleRig(seats, {
    listWorktrees: async () => ({ ok: true, repo: '/proj', worktrees: [] }),
    commitsOnBranch: async () => ({ ok: true, count: 7, base: 'ba5e' }),
  });
  rig.m._writeTicketCost(rig.team, {
    id: 't22', role: 'hand', assignee: 'hand', state: 'done',
    taskDir: 'tasks/role-foreign-tree', openedAt: 1, closedAt: 2,
  });
  await settle();
  const rec = rig.read('role-foreign-tree');
  assert.strictEqual(rec.ticket, 't22');   // ENTER, as above
  assert.deepStrictEqual(
    [rec.waste.worktreeMinted, rec.waste.commits, rec.waste.zeroCommit, rec.waste.commitsBase],
    [false, null, null, null],
    "another ticket's checkout is not this ticket's waste");
  rig.cleanup();
});

test("a ticket's own worktree wins over the record's, even for an exact seat", async () => {
  // 63 live tickets pin to a long-lived NAME-addressed seat (`clodex-hand`), not
  // to a minted ephemeral one. Such a seat can carry a `worktree:` of its own,
  // unrelated to any ticket — so resolving exactly is not enough to make the
  // record's tree this ticket's tree. For a minted ticket seat the two are the
  // same object and this ordering is inert; where they differ, the ticket's is
  // right by construction.
  const seats = ROLE_SEATS.map((s) => (s.name === 'team-hand-1'
    ? { ...s, worktree: { path: '/tmp/wt-personal', branch: 'personal', baseSha: 'dead' } } : s));
  const rig = mkRoleRig(seats, {
    listWorktrees: async () => ({ ok: true, repo: '/proj', worktrees: [] }),
    commitsOnBranch: async (_cwd, branch, base) => ({ ok: true, count: branch === 't29' ? 3 : 99, base: base || 'none' }),
  });
  rig.m._writeTicketCost(rig.team, {
    id: 't29', role: 'hand', assignee: 'team-hand-1', state: 'done',
    worktree: { path: '/tmp/wt-t29', branch: 't29', baseSha: 'ba5e' },
    taskDir: 'tasks/ticket-tree-wins', openedAt: 1, closedAt: 2,
  });
  await settle();
  const rec = rig.read('ticket-tree-wins');
  // ENTER: the seat DID resolve exactly — otherwise the worktree precedence
  // below is never reached and the assertion passes for the wrong reason.
  assert.deepStrictEqual([rec.sessions.attribution, rec.seat], ['seat', 'team-hand-1']);
  assert.deepStrictEqual([rec.waste.worktreeMinted, rec.waste.commits, rec.waste.commitsBase],
    [true, 3, 'ba5e'], "the ticket's own branch is what its waste is measured on");
  rig.cleanup();
});

test('an exact-pinned seat whose record is gone keeps its NAME, with a null ledger', async () => {
  // A seat archived or deleted after the ticket closed leaves no persistence
  // entry. The ledger is genuinely unknown, but the NAME is still the only join
  // key back to that seat's other artifacts — dropping it makes the row
  // unlinkable as well as unmeasured, which is a second loss for no gain.
  // `attribution: 'unknown'` + `seatResolved: false` already carry the no-ledger
  // fact, so the name costs nothing.
  const rig = mkRoleRig();
  rig.m._writeTicketCost(rig.team, {
    id: 't30', role: 'hand', assignee: 'team-hand-gone', state: 'done',
    taskDir: 'tasks/pinned-seat-gone', openedAt: 1, closedAt: 2,
  });
  await settle();
  const rec = rig.read('pinned-seat-gone');
  assert.strictEqual(rec.ticket, 't30');   // ENTER, as above
  assert.deepStrictEqual(
    [rec.seat, rec.sessions.attribution, rec.sessions.seatResolved, rec.usd, rec.tokens.input],
    ['team-hand-gone', 'unknown', false, null, null],
    'the name survives; only the measurement is missing');
  rig.cleanup();
});

test('a role ticket closed by a seat holding that role bills THAT seat', async () => {
  // The one case where closedBy is evidence: the closer holds the ticket's role,
  // so it is a hand reporting its own work. `team-hand-1` is live first, so a
  // first-live-seat scan would answer 11 here.
  const rig = mkRoleRig();
  rig.m._writeTicketCost(rig.team, {
    id: 't23', role: 'hand', assignee: 'hand', state: 'done', closedBy: 'team-hand-2',
    taskDir: 'tasks/role-closer', openedAt: 1, closedAt: 2,
  });
  await settle();
  const rec = rig.read('role-closer');
  assert.deepStrictEqual(
    [rec.sessions.attribution, rec.sessions.seatResolved, rec.seat, rec.wireLabel, rec.usd],
    ['role-closer', true, 'team-hand-2', 'team.t50.hand', 22]);
  rig.cleanup();
});

test('a seat-pinned ticket is billed exactly, and an unstaffed role measures nothing', async () => {
  // The exact case — the worktree flow re-pinned `assignee` to a seat name.
  // Also the control for the tests above: they assert absences, and a resolver
  // that resolved NOTHING would satisfy all of them.
  const rig = mkRoleRig();
  rig.m._writeTicketCost(rig.team, {
    id: 't24', role: 'hand', assignee: 'team-hand-1', state: 'done', closedBy: 'team-lead',
    taskDir: 'tasks/seat-pinned', openedAt: 1, closedAt: 2,
  });
  await settle();
  const rec = rig.read('seat-pinned');
  assert.deepStrictEqual(
    [rec.sessions.attribution, rec.sessions.seatResolved, rec.seat, rec.usd],
    ['seat', true, 'team-hand-1', 11],
    'a pinned seat is exact, and closedBy does not override it');

  // Nobody live in the role and no closer: unknown, not zero.
  const bare = mkRoleRig([]);
  bare.m._writeTicketCost(bare.team, {
    id: 't25', role: 'hand', assignee: 'hand', state: 'done',
    taskDir: 'tasks/role-unstaffed', openedAt: 1, closedAt: 2,
  });
  await settle();
  const miss = bare.read('role-unstaffed');
  assert.strictEqual(miss.sessions.seatResolved, false);
  assert.strictEqual(miss.usd, null, 'a seat that could not be found spent an UNKNOWN amount');
  assert.strictEqual(miss.tokens.input, null);

  rig.cleanup();
  bare.cleanup();
});

test('a taskDir that escapes the projects root writes nothing at all', async () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'clodex-ud-'));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'clodex-repo-'));
  const escapeTarget = fs.mkdtempSync(path.join(os.tmpdir(), 'clodex-outside-'));
  const { home, registryDir } = mkHome();
  const { m } = mkManager({ persistence: mkPersistence(), userData, home, registryDir });
  m._teamLiveSeatNames = () => [];
  // taskDir is agent-written spec text and this is the first path derived from
  // it that Clodex WRITES to; a `..` walk must produce no file anywhere.
  m._writeTicketCost({ name: 'team', root: repo }, {
    id: 't12', assignee: 'x', state: 'done',
    taskDir: path.join('tasks', path.relative(path.join(projectDirFor(registryDir, repo), 'tasks'), escapeTarget)),
  });
  await settle();
  assert.deepStrictEqual(fs.readdirSync(escapeTarget), [], 'nothing may be written outside the projects root');

  fs.rmSync(userData, { recursive: true, force: true });
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(escapeTarget, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

test('a ticket with no taskDir writes nothing, and a broken ledger still records waste', async () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'clodex-ud-'));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'clodex-repo-'));
  const { home, registryDir } = mkHome();
  const projDir = projectDirFor(registryDir, repo);
  // No wire-totals.json at all: the read fails and the rollup must degrade to
  // its waste half rather than skipping the artifact. The zero-commit case is
  // exactly the one the counter grades, so losing it here would hide it.
  const persistence = mkPersistence([{ name: 's', sessionId: 'gone', worktree: { path: '/tmp/wt-9', branch: 't9' } }]);
  const { m } = mkManager({
    persistence, userData, home, registryDir,
    gitWorktree: {
      listWorktrees: async () => ({ ok: false, worktrees: [] }),
      commitsOnBranch: async () => ({ ok: true, count: 0, base: 'ba5e' }),
    },
  });
  m._teamLiveSeatNames = () => ['s'];

  m._writeTicketCost({ name: 'team', root: repo }, { id: 't8', assignee: 's', state: 'done' });
  await settle();
  assert.ok(!fs.existsSync(projDir), 'no taskDir ⇒ no artifact anywhere');

  m._writeTicketCost({ name: 'team', root: repo }, {
    id: 't9', role: 'hand', assignee: 's', state: 'done', taskDir: 'tasks/broken-ledger',
    openedAt: 1, closedAt: 2, worktree: { path: '/tmp/wt-9', branch: 't9' },
  });
  await settle();
  const rec = JSON.parse(fs.readFileSync(path.join(projDir, 'tasks', 'broken-ledger', 'COST.json'), 'utf8'));
  assert.strictEqual(rec.usd, 0, 'the seat DID resolve — an empty ledger for a known seat is a real zero');
  assert.strictEqual(rec.tokens.cachedFraction, null, 'no ledger is "no data", never a cached fraction of 0');
  assert.strictEqual(rec.waste.zeroCommit, true, 'the t290 case must survive a missing ledger');
  assert.strictEqual(rec.waste.orphanedCheckouts, null, 'a failed sweep is unknown, not zero');
  assert.strictEqual(rec.waste.unclaimedNonMain, null, 'and the slot is present, so the schema does not vary');

  fs.rmSync(userData, { recursive: true, force: true });
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});
