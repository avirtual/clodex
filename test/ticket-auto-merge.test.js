'use strict';
// Run: node --test test/ticket-auto-merge.test.js
//
// t361 — an ACCEPT lands the branch on master by itself; everything else
// escalates. The edge the loop used to stop dead at.
//
// The merge runs against a REAL git repo, for the reason ticket-loop-verify's
// header gives about check 2 and more so here: this step WRITES to the shared
// checkout. A stubbed gitWorktree would prove the loop calls the functions it
// calls and nothing at all about whether master ends up carrying the work, on
// the right branch, with a merge commit, or about whether a revert really puts
// it back. Every assertion below reads git.
//
// The suite the merge runs afterwards is a planted stub runner, exactly as in
// ticket-loop-verify: a test that shelled out to the real suite would be the
// slowest thing in the suite and would recurse. So these pin the CONTRACT with
// the runner — which arm each outcome takes — not that the real suite runs.

const { test } = require('node:test');
const assert = require('node:assert');
const fsReal = require('node:fs');
const pathReal = require('node:path');
const osReal = require('node:os');
const { execFileSync } = require('node:child_process');

const { createSessionManager } = require('../session-manager');
const ticketsMod = require('../tickets-store');
const { intentEnabled } = require('../intent-catalog');

const SHIPPED_REVIEWER_TEMPLATE = {
  name: 'clodex-team-reviewer',
  systemPromptFile: 'clodex-team-reviewer',
  intents: [],
  tools: ['Read', 'Grep', 'Glob'],
  env: {},
};

function git(cwd, args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}

// The shapes are the ones ticket-loop-verify copied off a real run of
// scripts/run-tests.js; only the three this file needs are here.
const SUITE_STUBS = {
  green: 'console.log("TOTALS: 5 pass, 0 fail, 5 tests");\nprocess.exit(0);\n',
  red: 'console.log(".XX");\nconsole.log("");\nconsole.log("Failed tests:");\nconsole.log("");\n'
    + 'console.log("\\u2716 the merge broke this (1.15ms)");\n'
    + 'console.log("\\u2716 and this one too (0.42ms)");\n'
    + 'console.log("TOTALS: 3 pass, 2 fail, 5 tests");\nprocess.exit(1);\n',
  // Died before it could summarize: nothing was verified. An unverified merge
  // sitting on master is the state the revert exists to prevent, so this arm
  // undoes the merge too even though it is not a RED suite.
  crash: 'console.error("SyntaxError: Unexpected end of input");\nprocess.exit(1);\n',
};

// A real repo whose MASTER is clean and whose branch carries one real commit.
//
// The .gitignore is committed in the base commit and is load-bearing, not
// housekeeping: the fixture plants a stub runner and a node_modules dir inside
// the checkout, and the merge's step 3 refuses a dirty tree. Without it every
// subject here would escalate at clean-tree and the assertions downstream would
// be measuring that escalation instead of the merge.
function mkRepo() {
  const dir = fsReal.mkdtempSync(pathReal.join(osReal.tmpdir(), 'clodex-merge-repo-'));
  git(dir, ['init', '-q', '-b', 'master']);
  git(dir, ['config', 'user.email', 't@t.t']);
  git(dir, ['config', 'user.name', 'T']);
  fsReal.writeFileSync(pathReal.join(dir, '.gitignore'), 'node_modules/\nscripts/\nwt/\n');
  fsReal.writeFileSync(pathReal.join(dir, 'base.txt'), 'base\n');
  git(dir, ['add', '.gitignore', 'base.txt']);
  git(dir, ['commit', '-q', '-m', 'base']);
  const baseSha = git(dir, ['rev-parse', 'HEAD']);
  git(dir, ['branch', 'tl-1']);
  return { dir, baseSha };
}

// One commit on the ticket branch, through git, so the merge moves real content.
function commitOnBranch(dir, branch, file, body) {
  const cur = git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
  git(dir, ['checkout', '-q', branch]);
  fsReal.writeFileSync(pathReal.join(dir, file), body);
  git(dir, ['add', file]);
  git(dir, ['commit', '-q', '-m', `work on ${file}`]);
  const sha = git(dir, ['rev-parse', 'HEAD']);
  git(dir, ['checkout', '-q', cur]);
  return sha;
}

// `suite` is the runner planted in the ROOT checkout, because the post-merge run
// verifies MASTER and runs there — not in the ticket's worktree, which is where
// the loop's own verify step runs.
function mkMerge({ repo, ticketOver = {}, suite = 'green' } = {}) {
  fsReal.mkdirSync(pathReal.join(repo.dir, 'scripts'), { recursive: true });
  fsReal.mkdirSync(pathReal.join(repo.dir, 'node_modules'), { recursive: true });
  fsReal.writeFileSync(pathReal.join(repo.dir, 'scripts', 'run-tests.js'), SUITE_STUBS[suite]);

  const home = fsReal.mkdtempSync(pathReal.join(osReal.tmpdir(), 'clodex-merge-'));
  const pdir = pathReal.join(home, 'library', 'prompts', 'system');
  fsReal.mkdirSync(pdir, { recursive: true });
  fsReal.writeFileSync(pathReal.join(pdir, 'clodex-team-reviewer.md'), '# reviewer\n');

  const tstore = ticketsMod.createTicketsStore({ clodexHome: home });
  const team = {
    name: 'team', root: repo.dir, lead: 'lead', watchdogMs: null,
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
  const tags = [];
  const broadcasts = [];
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
    pluginRowFor: require('../intent-registry').pluginRowFor,
    validIntentNames: require('../intent-registry').validIntentNames,
    fs: fsReal,
    path: pathReal,
    os: osReal,
    ensureDir: require('../fs-util').ensureDir,
    // REAL, deliberately — see the header. The merge WRITES to this repo.
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
    log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    resolveTeam: (cwd) => (cwd && cwd.startsWith(repo.dir) ? team : null),
    findProjectRoot: (cwd) => (cwd && cwd.startsWith(repo.dir) ? repo.dir : null),
  };
  const SessionManager = createSessionManager(deps);
  const m = new SessionManager();
  const created = [];
  m._injectText = (s, text, opts) => {
    const out = opts && typeof opts.produce === 'function' ? opts.produce() : text;
    if (out == null || out === '') return;
    injected.push(out);
  };
  m._broadcast = (channel, msg) => broadcasts.push({ channel, msg });
  m._sendToSession = () => {};
  m._gatedDeliver = (target, sender, body, urgent, tag, onWrite) => {
    gated.push({ target, sender, body }); tags.push(tag);
    if (typeof onWrite === 'function') onWrite();
    return { queued: true };
  };
  m._deliverMessage = () => {};
  m._deliverPassive = () => {};
  m._deliverParkedActive = () => {};
  m.create = async (name, ...rest) => { created.push({ name, systemPrompt: rest[5] }); };
  m.kill = async (n) => { persistence.remove(n); };
  const seat = (name, cwd = repo.dir) => {
    m.sessions.set(name, { name, type: 'claude', agentType: 'claude', cwd, pty: { pid: 1 }, activityState: 'idle' });
    return m.sessions.get(name);
  };
  seat('lead');
  seat('team-hand');

  // The ticket as the loop leaves it when the reviewer is spawned: closed, held
  // at the review step, with a tree behind it.
  const ticket = {
    id: 't1', state: 'done', loopStep: 'review',
    spec: 'make the widget reentrant — tasks/merge-fixture', taskDir: 'tasks/merge-fixture',
    assignee: 'team-hand', role: 'hand', openedAt: Date.now(), lastActivityAt: Date.now(),
    startedAt: Date.now(), closedAt: Date.now(), closedBy: 'team-hand',
    report: 'did it; suite green at 4999', reportedBy: 'team-hand',
    worktree: { path: pathReal.join(repo.dir, 'wt'), branch: 'tl-1', baseSha: repo.baseSha },
    ...ticketOver,
  };
  tstore.save(team.root, [ticket]);

  return {
    m, team, home, tstore, persistence, injected, gated, tags, broadcasts, created, seat,
    one: (id = 't1') => tstore.load(team.root).find((t) => t.id === id),
    esc: () => gated.filter((g) => /ESCALATED/.test(g.body)),
    landed: () => gated.filter((g) => /MERGED/.test(g.body)),
    // Reads MASTER, not the index or a variable this file computed.
    masterHead: () => git(repo.dir, ['rev-parse', 'master']),
    masterLog: () => git(repo.dir, ['log', '--format=%s', 'master']),
    // Seats a reviewer the way _handleReviewDone's guard demands.
    reviewer: (name = 'team-reviewer-1', reviewTicket = 't1') => {
      persistence.upsert({ name, ephemeral: true, reviewFor: 'lead', reviewTicket });
      return seat(name);
    },
  };
}

const ACCEPT = 'VERDICT: ACCEPT\n\nMUST-FIX\n(none)\n\nNITS\n- the comment could be shorter\n';
const LANDED = { verdict: 'ACCEPT', mustFix: null, reviewRound: 1 };

// ── the green path: the branch actually lands ──────────────────────────────

test('an ACCEPT merges the branch into master with a merge commit', async () => {
  const repo = mkRepo();
  commitOnBranch(repo.dir, 'tl-1', 'work.txt', 'the work\n');
  const f = mkMerge({ repo });
  const before = f.masterHead();
  assert.ok(!fsReal.existsSync(pathReal.join(repo.dir, 'work.txt')),
    'ENTER: master does not carry the work yet, or this measures nothing');

  await f.m._autoMergeTicket(f.team, 't1', LANDED, ACCEPT);

  assert.deepStrictEqual(f.esc(), [], 'a clean accept must not escalate');
  const head = f.masterHead();
  assert.notStrictEqual(head, before, 'master moved');
  // --no-ff is the claim, and only the PARENT COUNT proves it: a fast-forward
  // also moves master and also makes the file appear, so every other assertion
  // here passes under one.
  const parents = git(repo.dir, ['rev-list', '--parents', '-n', '1', 'HEAD']).split(/\s+/);
  assert.strictEqual(parents.length, 3, 'HEAD is a merge commit with two parents, not a fast-forward');
  assert.strictEqual(fsReal.readFileSync(pathReal.join(repo.dir, 'work.txt'), 'utf8'), 'the work\n',
    'and the working tree really carries the branch content');
});

test('the merge message names the ticket, the branch and the review rounds', async () => {
  const repo = mkRepo();
  commitOnBranch(repo.dir, 'tl-1', 'work.txt', 'the work\n');
  const f = mkMerge({ repo });

  await f.m._autoMergeTicket(f.team, 't1', { ...LANDED, reviewRound: 3 }, ACCEPT);

  assert.deepStrictEqual(f.esc(), [], 'ENTER: the merge happened, so there is a message to read');
  const body = git(repo.dir, ['log', '-1', '--format=%B', 'master']);
  assert.match(body, /^Merge t1: /m, 'the subject names the ticket');
  assert.match(body, /make the widget reentrant/, 'and carries its title');
  assert.match(body, /Branch: tl-1/);
  assert.match(body, /Review rounds: 3/, 'the rounds come off the landed verdict, not a guess');
});

test('a backtick in the ticket title survives into the merge message verbatim', async () => {
  // The title is agent-written text and reaches git unescaped, so this pins that
  // shell metacharacters in it are not mangled or expanded on the way.
  //
  // It does NOT pin the `-F <file>` route, and must not be read as doing so:
  // measured, this subject passes identically against a build that switches to
  // `-m`. The reason is that git-worktree's `git()` runs execFile with an argv
  // array and NO shell, so there is no substitution for a backtick to trigger in
  // either form. `-F` is still what ships — the message is multi-line by
  // construction, which is a real argument — but the shell-injection argument for
  // it does not apply to this codebase, and no assertion here can enforce the flag.
  const repo = mkRepo();
  commitOnBranch(repo.dir, 'tl-1', 'work.txt', 'the work\n');
  const f = mkMerge({ repo, ticketOver: { spec: 'fix the `loopStep` guard — tasks/merge-fixture' } });

  await f.m._autoMergeTicket(f.team, 't1', LANDED, ACCEPT);

  assert.deepStrictEqual(f.esc(), [], 'ENTER: the merge happened');
  const body = git(repo.dir, ['log', '-1', '--format=%B', 'master']);
  assert.match(body, /fix the `loopStep` guard/, 'the backticked title is in the message, unexpanded');
});

test('the lead is told the merge landed, and that a CHANGELOG entry is owed', async () => {
  const repo = mkRepo();
  commitOnBranch(repo.dir, 'tl-1', 'work.txt', 'the work\n');
  const f = mkMerge({ repo });

  await f.m._autoMergeTicket(f.team, 't1', LANDED, ACCEPT);

  const notes = f.landed();
  assert.strictEqual(notes.length, 1, 'ENTER: exactly one merge notification');
  assert.strictEqual(notes[0].target, 'lead', 'it goes to the lead');
  assert.match(notes[0].body, /\bt1\b/, 'naming the ticket');
  assert.match(notes[0].body, /tl-1/, 'and the branch');
  assert.match(notes[0].body, new RegExp(f.masterHead().slice(0, 12)), 'and the merge sha, so it can be undone');
  // CHANGELOG.md is deliberately not written by the merge — it conflicts across
  // every live branch — so the debt must be STATED or the release ships without it.
  assert.match(notes[0].body, /CHANGELOG/, 'the CHANGELOG debt is stated');
});

test('the merge does NOT touch CHANGELOG.md and does NOT accept the ticket', async () => {
  const repo = mkRepo();
  // A CHANGELOG on master, so "untouched" is a real observation rather than a
  // statement about a file that never existed.
  fsReal.writeFileSync(pathReal.join(repo.dir, 'CHANGELOG.md'), '# Changelog\n\n## Unreleased\n');
  git(repo.dir, ['add', 'CHANGELOG.md']);
  git(repo.dir, ['commit', '-q', '-m', 'changelog']);
  git(repo.dir, ['branch', '-f', 'tl-1', 'HEAD']);
  const baseSha = git(repo.dir, ['rev-parse', 'HEAD']);
  commitOnBranch(repo.dir, 'tl-1', 'work.txt', 'the work\n');
  const f = mkMerge({ repo: { ...repo, baseSha }, ticketOver: { worktree: { path: pathReal.join(repo.dir, 'wt'), branch: 'tl-1', baseSha } } });

  await f.m._autoMergeTicket(f.team, 't1', LANDED, ACCEPT);

  assert.deepStrictEqual(f.esc(), [], 'ENTER: the merge happened');
  assert.strictEqual(fsReal.readFileSync(pathReal.join(repo.dir, 'CHANGELOG.md'), 'utf8'), '# Changelog\n\n## Unreleased\n',
    'CHANGELOG.md is byte-untouched — it stays the lead\'s');
  const t = f.one();
  // Accept retires the seat and DESTROYS the worktree. A merge is undoable by a
  // revert; a destroyed worktree is not, so that call stays the lead's.
  assert.ok(!('acceptedAt' in t), 'the ticket is not auto-accepted');
  assert.deepStrictEqual(t.worktree, { path: pathReal.join(repo.dir, 'wt'), branch: 'tl-1', baseSha },
    'and the worktree record is untouched');
  assert.ok(f.m.sessions.has('team-hand'), 'the hand seat survives the merge');
});

// ── step 1: the must-fixes come off the BODY, never off a header count ─────

test('an ACCEPT whose BODY still lists must-fixes escalates instead of merging', async () => {
  const repo = mkRepo();
  commitOnBranch(repo.dir, 'tl-1', 'work.txt', 'the work\n');
  const f = mkMerge({ repo });
  const before = f.masterHead();

  await f.m._autoMergeTicket(f.team, 't1',
    // `landedOn.mustFix` says NOTHING TO FIX, which is the shape that would let
    // a caller-trusting implementation merge. The body is the truth.
    { verdict: 'ACCEPT', mustFix: null, reviewRound: 1 },
    'VERDICT: ACCEPT\n\nMUST-FIX\n- the guard is inverted\n- the sweep drops the row\n');

  const esc = f.esc();
  assert.strictEqual(esc.length, 1, 'exactly one escalation');
  assert.match(esc[0].body, /merge: must-fix/, 'it names the step that refused');
  assert.match(esc[0].body, /the guard is inverted/, 'and carries the must-fixes as evidence');
  assert.match(esc[0].body, /2 items/, 'counted off the body');
  assert.strictEqual(f.masterHead(), before, 'master did not move');
  assert.deepStrictEqual(f.landed(), [], 'and no merge was announced');
});

test('a header that MISCOUNTS must-fixes does not block a merge whose body says none', async () => {
  // Seven confirmed instances of a DM header saying "10 must-fixes" over a body
  // reading "(none)". A gate reading the count would refuse every one of those
  // merges — the loop would stop dead at exactly the case it exists to close,
  // and it would look like correct caution.
  const repo = mkRepo();
  commitOnBranch(repo.dir, 'tl-1', 'work.txt', 'the work\n');
  const f = mkMerge({ repo });
  const before = f.masterHead();

  await f.m._autoMergeTicket(f.team, 't1',
    { verdict: 'ACCEPT', mustFix: '- a\n- b\n- c\n- d\n- e\n- f\n- g\n- h\n- i\n- j', reviewRound: 1 },
    'VERDICT: ACCEPT\n\nMUST-FIX\n(none)\n');

  assert.deepStrictEqual(f.esc(), [], 'the miscounted header must not block the merge');
  assert.notStrictEqual(f.masterHead(), before, 'the branch landed');
});

// ── step 2: the base must still be an ancestor ─────────────────────────────

test('a base that is no longer an ancestor escalates, and nothing is merged', async () => {
  const repo = mkRepo();
  commitOnBranch(repo.dir, 'tl-1', 'work.txt', 'the work\n');
  // A real sha reachable from nothing on tl-1 — the post-rebase state where the
  // tree the review was written against is gone.
  const orphan = execFileSync('git', ['-C', repo.dir, 'commit-tree', `${repo.baseSha}^{tree}`, '-m', 'orphan'], { encoding: 'utf8' }).trim();
  const f = mkMerge({ repo, ticketOver: { worktree: { path: pathReal.join(repo.dir, 'wt'), branch: 'tl-1', baseSha: orphan } } });
  const before = f.masterHead();

  await f.m._autoMergeTicket(f.team, 't1', LANDED, ACCEPT);

  const esc = f.esc();
  assert.strictEqual(esc.length, 1);
  assert.match(esc[0].body, /merge: base-is-ancestor/, 'the ancestry step is named, not the merge step');
  assert.match(esc[0].body, /NOT an ancestor/);
  assert.strictEqual(f.masterHead(), before, 'master did not move');
});

// ── step 3: the checkout must be clean and on master ───────────────────────

test('a dirty root checkout escalates rather than folding stray edits into the merge', async () => {
  const repo = mkRepo();
  commitOnBranch(repo.dir, 'tl-1', 'work.txt', 'the work\n');
  const f = mkMerge({ repo });
  // A TRACKED file modified — not an ignored one, which .gitignore would hide
  // and which would make this subject pass while measuring nothing.
  fsReal.writeFileSync(pathReal.join(repo.dir, 'base.txt'), 'someone was editing\n');
  assert.ok(git(repo.dir, ['status', '--porcelain']).length > 0, 'ENTER: the tree is really dirty');
  const before = f.masterHead();

  await f.m._autoMergeTicket(f.team, 't1', LANDED, ACCEPT);

  const esc = f.esc();
  assert.strictEqual(esc.length, 1);
  assert.match(esc[0].body, /merge: clean-tree/);
  assert.match(esc[0].body, /uncommitted changes/);
  assert.strictEqual(f.masterHead(), before, 'master did not move');
});

test('a root checkout parked on another branch escalates instead of merging there', async () => {
  const repo = mkRepo();
  commitOnBranch(repo.dir, 'tl-1', 'work.txt', 'the work\n');
  const f = mkMerge({ repo });
  git(repo.dir, ['checkout', '-q', '-b', 'somebody-elses-work']);
  const before = git(repo.dir, ['rev-parse', 'HEAD']);

  await f.m._autoMergeTicket(f.team, 't1', LANDED, ACCEPT);

  const esc = f.esc();
  assert.strictEqual(esc.length, 1);
  assert.match(esc[0].body, /merge: on-master/);
  assert.match(esc[0].body, /somebody-elses-work/, 'the escalation names where the checkout actually is');
  assert.strictEqual(git(repo.dir, ['rev-parse', 'HEAD']), before,
    'the branch the operator was on is untouched');
  assert.strictEqual(f.masterHead(), repo.baseSha, 'and master is where it was');
});

// ── step 4: a merge that cannot happen ─────────────────────────────────────

test('a conflicting merge escalates with the conflict and leaves the tree unwedged', async () => {
  const repo = mkRepo();
  // Both sides change the same line: git stops mid-merge with a conflicted
  // index. Left there, the shared checkout every other seat branches from is
  // wedged — which costs more than the merge was worth.
  commitOnBranch(repo.dir, 'tl-1', 'base.txt', 'the branch version\n');
  fsReal.writeFileSync(pathReal.join(repo.dir, 'base.txt'), 'the master version\n');
  git(repo.dir, ['add', 'base.txt']);
  git(repo.dir, ['commit', '-q', '-m', 'master moved']);
  const f = mkMerge({ repo });
  const before = f.masterHead();

  await f.m._autoMergeTicket(f.team, 't1', LANDED, ACCEPT);

  const esc = f.esc();
  assert.strictEqual(esc.length, 1);
  assert.match(esc[0].body, /merge: merge/, 'the merge step is named');
  // "Could not merge" without the conflict sends the lead to re-run it by hand
  // to find out what conflicted, which is the round trip this saves.
  assert.match(esc[0].body, /base\.txt/, 'the conflicting path rides the evidence');
  assert.strictEqual(f.masterHead(), before, 'master did not move');
  // THE assertion of this subject: the tree is usable afterwards. A conflicted
  // index satisfies every other check here.
  assert.strictEqual(git(repo.dir, ['status', '--porcelain']), '',
    'the merge was aborted, so the shared checkout is clean and not mid-merge');
});

test('an already-merged branch is reported, not announced as a merge that happened', async () => {
  // `--no-ff` on a contained branch prints "Already up to date", exits 0 and
  // creates NO commit. An implementation reading the exit code alone announces
  // a merge to the lead and then runs a suite that proves nothing about it.
  const repo = mkRepo();
  const sha = commitOnBranch(repo.dir, 'tl-1', 'work.txt', 'the work\n');
  git(repo.dir, ['merge', '-q', '--no-ff', '--no-edit', '-m', 'landed by hand', 'tl-1']);
  const f = mkMerge({ repo });
  const before = f.masterHead();
  assert.ok(sha && before !== repo.baseSha, 'ENTER: the branch really is already on master');

  await f.m._autoMergeTicket(f.team, 't1', LANDED, ACCEPT);

  const esc = f.esc();
  assert.strictEqual(esc.length, 1, 'the lead is told, once');
  assert.match(esc[0].body, /HEAD did not move/, 'and told that no merge commit exists');
  assert.deepStrictEqual(f.landed(), [], 'no merge is announced');
  assert.strictEqual(f.masterHead(), before, 'master is where it was');
});

// ── step 5: a red master is undone, never left ─────────────────────────────

test('a suite that goes RED after the merge reverts the merge and escalates', async () => {
  const repo = mkRepo();
  commitOnBranch(repo.dir, 'tl-1', 'work.txt', 'the work\n');
  const f = mkMerge({ repo, suite: 'red' });
  const before = f.masterHead();

  await f.m._autoMergeTicket(f.team, 't1', LANDED, ACCEPT);

  const esc = f.esc();
  assert.strictEqual(esc.length, 1, 'ENTER: exactly one escalation');
  assert.match(esc[0].body, /merge: suite/, 'the suite step is named');
  // The failing NAMES, not a count: a red master blocks every other ticket, and
  // "the suite failed" makes the lead re-run it to learn what.
  assert.match(esc[0].body, /the merge broke this/, 'the failing test names ride the escalation');
  assert.match(esc[0].body, /and this one too/);
  assert.match(esc[0].body, /3\/5 passing, 2 failing/);
  assert.match(esc[0].body, /REVERTED/, 'and it says the undo happened');

  // THE assertion: master is BACK. The merge commit stays in history — a revert
  // is a new commit, not an erasure — so the content is what proves the undo.
  assert.notStrictEqual(f.masterHead(), before, 'master carries the merge and its revert');
  assert.ok(!fsReal.existsSync(pathReal.join(repo.dir, 'work.txt')),
    'the branch content is no longer on master');
  assert.strictEqual(git(repo.dir, ['status', '--porcelain']), '', 'and the tree is clean');
  assert.deepStrictEqual(f.landed(), [], 'a reverted merge is never announced as landed');
});

test('a suite that could not RUN reverts the merge too, rather than leaving master unverified', async () => {
  // The spec names only RED. `ran:false` is undone as well, on the ground that
  // an UNVERIFIED merge sitting on master is exactly the state the revert
  // exists to prevent, and a revert is cheap and recoverable.
  const repo = mkRepo();
  commitOnBranch(repo.dir, 'tl-1', 'work.txt', 'the work\n');
  const f = mkMerge({ repo, suite: 'crash' });

  await f.m._autoMergeTicket(f.team, 't1', LANDED, ACCEPT);

  const esc = f.esc();
  assert.strictEqual(esc.length, 1);
  assert.match(esc[0].body, /merge: suite/);
  assert.match(esc[0].body, /could not be RUN/, 'the escalation distinguishes "did not run" from "failed"');
  assert.ok(!fsReal.existsSync(pathReal.join(repo.dir, 'work.txt')),
    'the unverified merge was undone');
});

test('the post-merge suite runs in the ROOT checkout, on the merged master', async () => {
  // Not in the ticket's worktree: the merge is the first moment the two trees
  // were ever combined, so a run in the branch's own tree verifies the state
  // that already passed the loop's verify step and says nothing about master.
  const repo = mkRepo();
  commitOnBranch(repo.dir, 'tl-1', 'work.txt', 'the work\n');
  const f = mkMerge({ repo });
  const seen = [];
  const real = f.m._runTicketSuite.bind(f.m);
  f.m._runTicketSuite = async (team, ticket, runIn) => { seen.push(runIn); return real(team, ticket, runIn); };

  await f.m._autoMergeTicket(f.team, 't1', LANDED, ACCEPT);

  assert.deepStrictEqual(seen, [repo.dir], 'the run is rooted at the team root, not the worktree');
  assert.deepStrictEqual(f.esc(), [], 'and it passed');
});

// ── the wiring: only an ACCEPT, only a ticket review ───────────────────────

test('review-done with an ACCEPT drives the merge, not merely marks it', async () => {
  // The wiring pin. Every other subject in this file calls _autoMergeTicket
  // directly, so all of them stay green if review-done never fires it — an
  // accepted ticket would sit unmerged forever and only the lead would notice.
  const repo = mkRepo();
  commitOnBranch(repo.dir, 'tl-1', 'work.txt', 'the work\n');
  const f = mkMerge({ repo });
  const rec = f.reviewer();
  const before = f.masterHead();

  f.m._handleReviewDone(f.m.sessions.get(rec.name), ACCEPT);
  // Fired unawaited from a sync handler, so let the git calls and the suite run.
  // Waits on the NOTIFICATION, not on master moving: the merge commit exists
  // before the post-merge suite does, so polling master would release this at a
  // point where the merge is still unverified and the notification not yet sent
  // — and the assertion below would then read 0 for a reason that is timing,
  // not behaviour.
  for (let i = 0; i < 400 && f.landed().length === 0 && f.esc().length === 0; i++) await new Promise((r) => setTimeout(r, 25));

  assert.notStrictEqual(f.masterHead(), before, 'closing the review reached an actual merge');
  assert.strictEqual(f.one().verdict, 'ACCEPT', 'ENTER: the verdict landed first');
  assert.strictEqual(f.landed().length, 1, 'and the lead was told once');
});

test('a REWORK verdict merges NOTHING and takes the path it always did', async () => {
  const repo = mkRepo();
  commitOnBranch(repo.dir, 'tl-1', 'work.txt', 'the work\n');
  const f = mkMerge({ repo });
  const rec = f.reviewer();
  const before = f.masterHead();

  f.m._handleReviewDone(f.m.sessions.get(rec.name), 'VERDICT: REWORK\n\nMUST-FIX\n- the guard is inverted\n');
  await new Promise((r) => setTimeout(r, 300));

  assert.strictEqual(f.one().verdict, 'REWORK', 'ENTER: the REWORK landed on the record');
  assert.strictEqual(f.masterHead(), before, 'master did not move');
  assert.deepStrictEqual(f.landed(), [], 'nothing was announced as merged');
  assert.deepStrictEqual(f.esc(), [], 'and the merge path was never entered, so it escalated nothing');
  // The unchanged behaviour: the lead still gets the verdict summary.
  assert.strictEqual(f.gated.length, 1, 'exactly the verdict notification, as before');
  assert.match(f.gated[0].body, /REWORK on ticket t1/);
});

test('an ad-hoc review with no ticket never reaches the merge path', async () => {
  // `[agent:team-review]` with no ticket seeds no reviewTicket, so
  // _landVerdictOnTicket returns null and the verdict falls through to the
  // asker. An ACCEPT there is a lead's question answered, not a ticket to land.
  const repo = mkRepo();
  commitOnBranch(repo.dir, 'tl-1', 'work.txt', 'the work\n');
  const f = mkMerge({ repo });
  f.persistence.upsert({ name: 'adhoc-1', ephemeral: true, reviewFor: 'lead' });
  f.seat('adhoc-1');
  const before = f.masterHead();

  f.m._handleReviewDone(f.m.sessions.get('adhoc-1'), ACCEPT);
  await new Promise((r) => setTimeout(r, 300));

  assert.strictEqual(f.gated.length, 1, 'ENTER: the verdict fell through to the asker');
  assert.strictEqual(f.gated[0].target, 'lead');
  assert.strictEqual(f.masterHead(), before, 'and nothing was merged');
  assert.deepStrictEqual(f.esc(), [], 'nor escalated');
});

test('a ticket worked in the SHARED checkout has no branch to land, and says nothing', async () => {
  // Same rule as the loop's: every step here is a question about a branch, and a
  // ticket without one has no answer. Silence, not an escalation — nothing went
  // wrong.
  const repo = mkRepo();
  const f = mkMerge({ repo, ticketOver: { worktree: null } });
  const before = f.masterHead();

  await f.m._autoMergeTicket(f.team, 't1', LANDED, ACCEPT);

  assert.deepStrictEqual(f.esc(), [], 'no escalation for a ticket that never had a tree');
  assert.deepStrictEqual(f.landed(), [], 'and no merge announced');
  assert.strictEqual(f.masterHead(), before);
});

// ── the absolute constraints ───────────────────────────────────────────────

test('no code path in the merge can push, and none stages with -A', () => {
  // A source pin because there is no fixture that can prove an absence at
  // runtime: a test asserting "no push happened" passes trivially against a
  // build that would push against a remote this fixture does not have. `push`
  // is irreversible in a way nothing else here is, and `add -A` would sweep a
  // sibling seat's uncommitted work into a merge commit.
  const gw = fsReal.readFileSync(pathReal.join(__dirname, '..', 'git-worktree.js'), 'utf8');
  const sm = fsReal.readFileSync(pathReal.join(__dirname, '..', 'session-manager.js'), 'utf8');
  for (const [name, src] of [['git-worktree.js', gw], ['session-manager.js', sm]]) {
    assert.ok(!/'push'/.test(src), `${name} must never invoke git push`);
    assert.ok(!/'add',\s*'-A'/.test(src) && !/'-A'/.test(src), `${name} must never stage with -A`);
  }
});

test('the revert of a merge passes a mainline, or the undo is not possible at all', () => {
  // git REFUSES to revert a merge commit without -m: omitting it turns the undo
  // into an error at precisely the moment master is broken and the undo is the
  // only way back. Pinned against real git rather than by reading the source,
  // because the refusal is git's behaviour and not ours.
  const dir = fsReal.mkdtempSync(pathReal.join(osReal.tmpdir(), 'clodex-revert-'));
  git(dir, ['init', '-q', '-b', 'master']);
  git(dir, ['config', 'user.email', 't@t.t']);
  git(dir, ['config', 'user.name', 'T']);
  fsReal.writeFileSync(pathReal.join(dir, 'a.txt'), 'a\n');
  git(dir, ['add', 'a.txt']);
  git(dir, ['commit', '-q', '-m', 'a']);
  git(dir, ['checkout', '-q', '-b', 'side']);
  fsReal.writeFileSync(pathReal.join(dir, 'b.txt'), 'b\n');
  git(dir, ['add', 'b.txt']);
  git(dir, ['commit', '-q', '-m', 'b']);
  git(dir, ['checkout', '-q', 'master']);
  git(dir, ['merge', '-q', '--no-ff', '--no-edit', '-m', 'merge side', 'side']);
  const mergeSha = git(dir, ['rev-parse', 'HEAD']);

  // Matched on git's actual wording, read off a real refusal: it says "is a
  // merge but no -m option was given", not "mainline". A regex guessed from the
  // documentation passed the throw and failed the message, which is the fixture
  // being wrong about the thing it is pinning.
  assert.throws(() => git(dir, ['revert', '--no-edit', mergeSha]),
    /is a merge but no -m option was given/, 'ENTER: git really refuses a mainline-less revert of a merge');
  const r = require('../git-worktree');
  return r.revertCommit(dir, mergeSha).then((out) => {
    assert.strictEqual(out.ok, true, 'the shipped revert passes a mainline and succeeds');
    assert.ok(!fsReal.existsSync(pathReal.join(dir, 'b.txt')), 'and the merged content is gone');
  });
});
