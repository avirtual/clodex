// Run: node --test
// t303 — the ticket verbs work with NO team. Covers project-root.js (the
// git-root walk, including the worktree→main-checkout rule) and the seven
// `[agent:task …]` handlers driven through a SOLO session-manager fixture.
//
// Every solo test asserts its PRECONDITION first: the fixture's `resolveTeam`
// really answers null for the cwd under test. A solo assertion in a fixture
// that happens to resolve a team runs the TEAM path and proves nothing — the
// behaviours are similar enough that most such assertions still pass.
const { test } = require('node:test');
const assert = require('node:assert');
const fsReal = require('node:fs');
const pathReal = require('node:path');
const osReal = require('node:os');

const { createSessionManager } = require('../session-manager');
const { findRepoRoot } = require('../project-root');
const { projectDirFor } = require('../clodex-paths');
const ticketsMod = require('../tickets-store');
const { intentEnabled } = require('../intent-catalog');

function tmp(prefix) {
  return fsReal.realpathSync(fsReal.mkdtempSync(pathReal.join(osReal.tmpdir(), prefix)));
}

// ---------------------------------------------------------------- project-root

test('findRepoRoot: a `.git` DIRECTORY makes that ancestor the root, from any depth', () => {
  const repo = tmp('clodex-pr-');
  fsReal.mkdirSync(pathReal.join(repo, '.git'));
  const deep = pathReal.join(repo, 'a', 'b', 'c');
  fsReal.mkdirSync(deep, { recursive: true });
  assert.strictEqual(findRepoRoot(repo), repo);
  assert.strictEqual(findRepoRoot(deep), repo, 'walks up to the repo root');
});

// The rule that keeps every ticket seat on the lead's board: seats work in
// worktrees, and a worktree answering with its own path would key a board dir
// (hashed over this string) that nothing else reads.
test('findRepoRoot: a linked WORKTREE resolves to the MAIN checkout, not to itself', () => {
  const base = tmp('clodex-pr-');
  const main = pathReal.join(base, 'repo');
  const wt = pathReal.join(base, 'repo-feature');
  fsReal.mkdirSync(pathReal.join(main, '.git', 'worktrees', 'feature'), { recursive: true });
  fsReal.mkdirSync(wt);
  fsReal.writeFileSync(pathReal.join(wt, '.git'),
    `gitdir: ${pathReal.join(main, '.git', 'worktrees', 'feature')}\n`);
  assert.strictEqual(findRepoRoot(wt), main, 'worktree keys the main checkout');
  assert.strictEqual(findRepoRoot(wt), findRepoRoot(main), 'both agree on one root');
});

test('findRepoRoot: outside any repo → null (no cwd fallback)', () => {
  const bare = tmp('clodex-pr-');
  assert.strictEqual(findRepoRoot(bare), null);
  assert.strictEqual(findRepoRoot(''), null);
  assert.strictEqual(findRepoRoot(null), null);
});

// A submodule's `.git` FILE has no `worktrees/` segment. It must not be read as
// a worktree pointer; the walk continues to the containing repo.
test('findRepoRoot: a `.git` file WITHOUT a worktrees segment does not resolve as a worktree', () => {
  const repo = tmp('clodex-pr-');
  fsReal.mkdirSync(pathReal.join(repo, '.git'));
  const sub = pathReal.join(repo, 'vendor', 'sub');
  fsReal.mkdirSync(sub, { recursive: true });
  fsReal.writeFileSync(pathReal.join(sub, '.git'), `gitdir: ${pathReal.join(repo, '.git', 'modules', 'sub')}\n`);
  assert.strictEqual(findRepoRoot(sub), repo, 'falls through to the containing repo');
});

// ------------------------------------------------------------- solo fixture

// A REAL git repo on disk: findRepoRoot walks the filesystem, so a stubbed fs
// would test the stub and not the rule the board key depends on.
function mkSolo({ team = null, cwdSub = null } = {}) {
  const home = tmp('clodex-solo-home-');
  const repo = tmp('clodex-solo-repo-');
  fsReal.mkdirSync(pathReal.join(repo, '.git'));
  const cwd = cwdSub ? pathReal.join(repo, cwdSub) : repo;
  if (cwdSub) fsReal.mkdirSync(cwd, { recursive: true });

  const tstore = ticketsMod.createTicketsStore({ clodexHome: home });
  const injected = [];
  const gated = [];
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
    // The SOLO precondition, wired as production behaves: no team.json owns the
    // cwd, and `findProjectRoot` is itself team-derived so it answers null too.
    resolveTeam: (c) => (team && c && c.startsWith(team.root) ? team : null),
    findProjectRoot: (c) => (team && c && c.startsWith(team.root) ? team.root : null),
  };
  const SessionManager = createSessionManager(deps);
  const m = new SessionManager();
  m._injectText = (s, text, opts) => {
    const out = opts && typeof opts.produce === 'function' ? opts.produce() : text;
    if (out == null || out === '') return;
    injected.push(out);
  };
  m._broadcast = () => {};
  m._sendToSession = () => {};
  m._gatedDeliver = (target, sender, body) => { gated.push({ target, sender, body }); return { queued: true }; };

  const seat = (name, c = cwd) => {
    m.sessions.set(name, { name, type: 'claude', agentType: 'claude', cwd: c, pty: { pid: 1 }, activityState: 'idle' });
    return m.sessions.get(name);
  };
  const boardPath = (root) => pathReal.join(projectDirFor(home, root), 'tickets.json');
  return {
    m, home, repo, cwd, tstore, injected, gated, seat, deps, boardPath,
    load: () => tstore.load(repo),
    one: (id) => tstore.load(repo).find((t) => t.id === id),
    last: () => injected[injected.length - 1],
  };
}

// The precondition every solo test below leans on, asserted once as its own
// test so a fixture that silently starts resolving a team fails HERE — loudly
// and in one place — rather than turning each solo test into a team test.
test('solo fixture precondition: no team resolves for the session cwd', () => {
  const f = mkSolo();
  assert.strictEqual(f.deps.resolveTeam(f.cwd), null, 'resolveTeam answers null — this is the solo path');
  assert.strictEqual(f.deps.findProjectRoot(f.cwd), null, 'findProjectRoot is team-derived and null too');
});

// ------------------------------------------------------------------ the verbs

test('solo add: an unassigned ticket opens on the project board with no team', () => {
  const f = mkSolo();
  const s = f.seat('solo');
  assert.strictEqual(f.deps.resolveTeam(s.cwd), null, 'PRECONDITION: no team');

  f.m._handleTask(s, { type: 'task', sub: 'add', who: null, id: null, body: 'note to self\ndetail' });

  const t = f.one('t1');
  assert.ok(t, 'ticket persisted to the project board');
  assert.strictEqual(t.state, 'open');
  assert.strictEqual(t.assignee, null, 'unassigned — solo add opens backlog');
  assert.strictEqual(t.title, 'note to self');
  assert.strictEqual(t.opener, 'solo');
  assert.match(f.last(), /ticket t1 \(backlog\)/);
});

// The funnel's whole purpose. Not a path-formatting assertion: it pins that the
// SOLO write and the TEAM read land on one file, which is the failure the
// ruling called silent-split.
test('solo add writes the SAME board file a team rooted at that repo resolves', () => {
  const f = mkSolo();
  const s = f.seat('solo');
  assert.strictEqual(f.deps.resolveTeam(s.cwd), null, 'PRECONDITION: no team');
  f.m._handleTask(s, { type: 'task', sub: 'add', who: null, id: null, body: 'shared board' });

  const soloBoard = f.boardPath(f.repo);
  assert.ok(fsReal.existsSync(soloBoard), 'solo verb wrote the project board');
  // The path a team whose root IS this repo would key — same derivation, same file.
  assert.strictEqual(soloBoard, f.boardPath(findRepoRoot(f.cwd)),
    'solo and team-rooted derivations agree on one board');
  const onDisk = JSON.parse(fsReal.readFileSync(soloBoard, 'utf-8'));
  assert.strictEqual(onDisk.length, 1);
  assert.strictEqual(onDisk[0].id, 't1');
});

test('solo add from a SUBDIR keys the repo root, not the cwd', () => {
  const f = mkSolo({ cwdSub: 'src/deep' });
  const s = f.seat('solo');
  assert.strictEqual(f.deps.resolveTeam(s.cwd), null, 'PRECONDITION: no team');
  assert.notStrictEqual(f.cwd, f.repo, 'PRECONDITION: cwd is below the repo root');

  f.m._handleTask(s, { type: 'task', sub: 'add', who: null, id: null, body: 'from a subdir' });

  assert.strictEqual(f.load().length, 1, 'landed on the repo-root board');
  assert.ok(!fsReal.existsSync(f.boardPath(f.cwd)), 'no second board keyed to the subdir');
});

test('solo add: no git repo → refuses, naming why, and writes no board', () => {
  const f = mkSolo();
  const bare = tmp('clodex-norepo-');
  const s = f.seat('solo', bare);
  assert.strictEqual(f.deps.resolveTeam(bare), null, 'PRECONDITION: no team');
  assert.strictEqual(findRepoRoot(bare), null, 'PRECONDITION: not inside a repo');

  f.m._handleTask(s, { type: 'task', sub: 'add', who: null, id: null, body: 'nowhere' });

  assert.match(f.last(), /not on a team and is not inside a git repository/);
  assert.ok(!fsReal.existsSync(f.boardPath(bare)), 'no board minted outside a repo');
});

test('solo assign: the target names a LIVE SESSION (no roles exist to match)', () => {
  const f = mkSolo();
  const s = f.seat('solo');
  const worker = f.seat('worker');
  assert.strictEqual(f.deps.resolveTeam(s.cwd), null, 'PRECONDITION: no team');

  f.m._handleTask(s, { type: 'task', sub: 'add', who: null, id: null, body: 'work' });
  f.m._handleTask(s, { type: 'task', sub: 'assign', who: 'worker', id: 't1', body: '' });

  assert.strictEqual(f.one('t1').assignee, 'worker', 'assigned to the live session');
  assert.ok(f.gated.some((g) => g.target === 'worker'), 'spec delivered to that session');
  assert.ok(worker, 'the live session was the resolution target');
});

test('solo assign: an unknown target is refused in session vocabulary, not role vocabulary', () => {
  const f = mkSolo();
  const s = f.seat('solo');
  assert.strictEqual(f.deps.resolveTeam(s.cwd), null, 'PRECONDITION: no team');
  f.m._handleTask(s, { type: 'task', sub: 'add', who: null, id: null, body: 'work' });

  f.m._handleTask(s, { type: 'task', sub: 'assign', who: 'ghost', id: 't1', body: '' });

  assert.match(f.last(), /"ghost" is not a live session/);
  assert.doesNotMatch(f.last(), /team role/, 'solo must not offer a vocabulary it has no members of');
  assert.strictEqual(f.one('t1').assignee, null, 'unchanged');
});

// The lead gates are a no-op solo, not a refusal: there is exactly one actor.
test('solo done: the sender closes its own ticket with no lead in the system', () => {
  const f = mkSolo();
  const s = f.seat('solo');
  assert.strictEqual(f.deps.resolveTeam(s.cwd), null, 'PRECONDITION: no team');
  f.m._handleTask(s, { type: 'task', sub: 'add', who: null, id: null, body: 'finish me' });

  f.m._handleTask(s, { type: 'task', sub: 'done', who: null, id: 't1', body: 'did it' });

  const t = f.one('t1');
  assert.strictEqual(t.state, 'done');
  assert.strictEqual(t.closedBy, 'solo');
  assert.match(f.last(), /ticket t1 closed \(done\)/);
});

test('solo done: the ASSIGNEE may close, and no spec is dispatched onward', () => {
  const f = mkSolo();
  const s = f.seat('solo');
  const worker = f.seat('worker');
  assert.strictEqual(f.deps.resolveTeam(s.cwd), null, 'PRECONDITION: no team');
  f.m._handleTask(s, { type: 'task', sub: 'add', who: null, id: null, body: 'first' });
  f.m._handleTask(s, { type: 'task', sub: 'add', who: null, id: null, body: 'second' });
  f.m._handleTask(s, { type: 'task', sub: 'assign', who: 'worker', id: 't1', body: '' });
  f.m._handleTask(s, { type: 'task', sub: 'assign', who: 'worker', id: 't2', body: '' });
  const before = f.gated.length;

  f.m._handleTask(worker, { type: 'task', sub: 'done', who: null, id: 't1', body: 'done by assignee' });

  assert.strictEqual(f.one('t1').state, 'done', 'the assignee closed it');
  // _advanceSeat no-ops solo: t2 is open and assigned to `worker`, so a team
  // context would hand it over here. Solo must not auto-dispatch.
  assert.strictEqual(f.one('t2').state, 'open', 'the next ticket stays open');
  assert.deepStrictEqual(f.gated.slice(before).filter((g) => /^\[ticket t2\]/.test(g.body)), [],
    'no spec auto-advanced to a session that never enrolled');
});

test('solo reject / cancel: operate on the project board', () => {
  const f = mkSolo();
  const s = f.seat('solo');
  assert.strictEqual(f.deps.resolveTeam(s.cwd), null, 'PRECONDITION: no team');
  f.m._handleTask(s, { type: 'task', sub: 'add', who: null, id: null, body: 'a' });
  f.m._handleTask(s, { type: 'task', sub: 'add', who: null, id: null, body: 'b' });

  f.m._handleTask(s, { type: 'task', sub: 'cancel', who: null, id: 't2', body: 'not needed' });
  assert.strictEqual(f.one('t2').state, 'cancelled');

  f.m._handleTask(s, { type: 'task', sub: 'done', who: null, id: 't1', body: 'report' });
  f.m._handleTask(s, { type: 'task', sub: 'reject', who: null, id: 't1', body: 'redo it' });
  assert.strictEqual(f.one('t1').state, 'open', 'reject reopens on the solo board');
});

test('solo list: reads the project board and heads it with the repo basename', () => {
  const f = mkSolo();
  const s = f.seat('solo');
  assert.strictEqual(f.deps.resolveTeam(s.cwd), null, 'PRECONDITION: no team');
  f.m._handleTask(s, { type: 'task', sub: 'add', who: null, id: null, body: 'alpha task' });
  f.m._handleTask(s, { type: 'task', sub: 'add', who: null, id: null, body: 'beta task' });

  f.m._handleTask(s, { type: 'task', sub: 'list', who: null, id: null, body: '' });

  const out = f.last();
  assert.match(out, /alpha task/);
  assert.match(out, /beta task/);
  assert.match(out, new RegExp(`tickets on ${pathReal.basename(f.repo)}`),
    'headed by the derived root basename, locatable on disk');
});

test('solo park: parks and unparks without a team', () => {
  const f = mkSolo();
  const s = f.seat('solo');
  assert.strictEqual(f.deps.resolveTeam(s.cwd), null, 'PRECONDITION: no team');
  f.m._handleTask(s, { type: 'task', sub: 'add', who: null, id: null, body: 'later' });

  f.m._handleTask(s, { type: 'task', sub: 'park', who: null, id: 't1', body: '' });
  assert.strictEqual(f.one('t1').parked, true);
  f.m._handleTask(s, { type: 'task', sub: 'park', who: null, id: 't1', body: '' });
  assert.strictEqual(f.one('t1').parked, undefined, 'unparked clears the flag, not stores false');
});

// ------------------------------------------------- the compatibility line

// The team path must not move. Same repo on disk, but a team OWNS it: the board
// key comes from team.root and the role vocabulary is back.
test('team path unchanged: with a team resolved, the board keys team.root and roles still resolve', () => {
  const base = tmp('clodex-team-repo-');
  const root = pathReal.join(base, 'proj');
  fsReal.mkdirSync(pathReal.join(root, '.git'), { recursive: true });
  const team = {
    name: 'team', root, lead: 'lead', watchdogMs: null,
    roles: { lead: { instantiate: 'session' }, hand: { instantiate: 'session' } },
  };
  const f = mkSolo({ team });
  // Point the fixture's sessions at the TEAM's root rather than its own repo.
  const lead = f.seat('lead', root);
  f.seat('team-hand', root);
  assert.strictEqual(f.deps.resolveTeam(root), team, 'PRECONDITION: a team DOES resolve here');

  f.m._handleTask(lead, { type: 'task', sub: 'add', who: 'hand', id: null, body: 'team work' });

  const board = f.tstore.load(root);
  assert.strictEqual(board.length, 1, 'written to the team.root board');
  assert.strictEqual(board[0].assignee, 'team-hand', 'role resolved and re-pinned to the seat');
  assert.strictEqual(board[0].role, 'hand', 'the filed role survives — team semantics intact');
  assert.deepStrictEqual(f.gated, [{ target: 'team-hand', sender: 'lead', body: '[ticket t1] team work' }],
    'spec delivered through the unchanged team path');
});

test('team path unchanged: a non-lead still cannot open a ticket', () => {
  const base = tmp('clodex-team-repo-');
  const root = pathReal.join(base, 'proj');
  fsReal.mkdirSync(pathReal.join(root, '.git'), { recursive: true });
  const team = {
    name: 'team', root, lead: 'lead', watchdogMs: null,
    roles: { lead: { instantiate: 'session' }, hand: { instantiate: 'session' } },
  };
  const f = mkSolo({ team });
  const hand = f.seat('team-hand', root);
  assert.strictEqual(f.deps.resolveTeam(root), team, 'PRECONDITION: a team DOES resolve here');

  f.m._handleTask(hand, { type: 'task', sub: 'add', who: null, id: null, body: 'sneaky' });

  assert.match(f.last(), /only the team lead \(lead\) can open a ticket/,
    'the lead gate still refuses where a team exists');
  assert.strictEqual(f.tstore.load(root).length, 0, 'nothing written');
});
