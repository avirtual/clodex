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
const { createTicketsStore } = require('../tickets-store');
const { resolveProxyAgentId } = require('../proxy-util');
const tstore = createTicketsStore();

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
  const src = fs.readFileSync(path.join(__dirname, '..', 'session-manager.js'), 'utf8');

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
  const seeds = src.match(/wireLabel: \w+ \}/g) || [];
  assert.strictEqual(seeds.length, 2,
    `expected exactly 2 wireLabel seeds (reviewer + ticket seat), found ${seeds.length}`);

  for (const [label, seedRe, createRe] of [
    ['reviewer', /reviewFor: session\.name,\n\s*\.\.\.\(reviewLabel \?/, /name, type, cwd, postureArgs/],
    ['ticket seat', /name: seat\.name, ephemeral: true,\n\s*\.\.\.\(seatLabel \?/, /seat\.name, def\.type \|\| opener\.type/],
  ]) {
    const seedAt = src.search(seedRe);
    const createAt = src.search(createRe);
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

// The taskDir shapes REAL tickets carry. Measured over the live store: of 227
// tickets with a taskDir, 175 are relative and 52 tilde-prefixed — ZERO are
// absolute. A fixture passing an mkdtemp path (as this one first did) tests a
// shape that does not occur, and passes over a writer that mkdir -p's a literal
// `~` under the process cwd.
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

test('a ROLE-assigned ticket reports an unknown cost, never an authoritative $0', async () => {
  // Only the worktree-seat path re-pins `assignee` to a seat name; a ticket
  // assigned to a plain role keeps assignee:'hand', and nothing is stored under
  // a role name. Resolved through the role it finds the seat; unresolvable, the
  // record must say so rather than report a measured zero.
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'clodex-ud-'));
  fs.writeFileSync(path.join(userData, 'wire-totals.json'), JSON.stringify(LEDGER));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'clodex-repo-'));
  const { home, registryDir } = mkHome();
  const projDir = projectDirFor(registryDir, repo);
  const persistence = mkPersistence([{ name: 'team-hand-7', sessionId: 's1', wireLabel: 'team.t7.hand' }]);
  const team = { name: 'team', root: repo, roles: { hand: {} } };

  const { m } = mkManager({ persistence, userData, home, registryDir });
  m._teamLiveSeatNames = () => ['team-hand-7'];
  m._writeTicketCost(team, {
    id: 't10', role: 'hand', assignee: 'hand', state: 'done',
    taskDir: 'tasks/role-assigned', openedAt: 1, closedAt: 2,
  });
  await settle();
  const found = JSON.parse(fs.readFileSync(path.join(projDir, 'tasks', 'role-assigned', 'COST.json'), 'utf8'));
  assert.strictEqual(found.sessions.seatResolved, true, 'the role must resolve to its live seat');
  assert.strictEqual(found.seat, 'team-hand-7', 'and the artifact names the SEAT, not the role');
  assert.strictEqual(found.usd, 3.5, "and carries that seat's spend");

  // Nobody live in the role: unknown, not zero.
  const { m: m2 } = mkManager({ persistence: mkPersistence(), userData, home, registryDir });
  m2._teamLiveSeatNames = () => [];
  m2._writeTicketCost(team, {
    id: 't11', role: 'hand', assignee: 'hand', state: 'done',
    taskDir: 'tasks/role-unstaffed', openedAt: 1, closedAt: 2,
  });
  await settle();
  const miss = JSON.parse(fs.readFileSync(path.join(projDir, 'tasks', 'role-unstaffed', 'COST.json'), 'utf8'));
  assert.strictEqual(miss.sessions.seatResolved, false);
  assert.strictEqual(miss.usd, null, 'a seat that could not be found spent an UNKNOWN amount');
  assert.strictEqual(miss.tokens.input, null);

  fs.rmSync(userData, { recursive: true, force: true });
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
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
