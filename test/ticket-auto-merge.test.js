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
  // `.test-digest.lock/` is ignored in the real repo for the same reason it is
  // ignored here: the suite-in-flight subjects PLANT one, and step 3 refuses a
  // dirty tree — without this they would measure a clean-tree escalation and
  // never reach the gate they are about.
  fsReal.writeFileSync(pathReal.join(dir, '.gitignore'), 'node_modules/\nscripts/\nwt/\nwt2/\n.test-digest.lock/\n');
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
// `gitOver` overrides individual gitWorktree functions. Used by ONE subject, to
// reach an arm real git cannot be talked into from here: a merge that fails
// before it starts needs an unresolvable branch, which step 2 rejects first. The
// shape it returns is pinned against real git by the subject below it, so the
// stub cannot drift into describing a merge git would never produce.
function mkMerge({ repo, ticketOver = {}, suite = 'green', gitOver = null, isAliveOver = null } = {}) {
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
  const logs = [];
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
    // REAL, like gitWorktree: the suite-in-flight gate asks whether a pid that
    // wrote a lock file is still running, and a stub answering `false` would
    // turn every "a live suite holds the lock" subject into a merge that
    // proceeded — the assertions would then be measuring the stub.
    isAlive: isAliveOver || ((pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }),
    ensureDir: require('../fs-util').ensureDir,
    // REAL, deliberately — see the header. The merge WRITES to this repo.
    gitWorktree: gitOver ? { ...require('../git-worktree'), ...gitOver } : require('../git-worktree'),
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
    m, team, home, tstore, persistence, injected, gated, tags, broadcasts, created, seat, logs,
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

  // The body carries a complete, ready-to-fire `[agent:task accept t1]`, inert
  // ONLY because prose precedes it on its line — IntentScanner's parse is
  // ^-anchored. A reflow putting it at column 1 makes the LEAD auto-accept on
  // receipt: seat retired, worktree destroyed, which is the one thing this step
  // promises not to do and the one action here no revert undoes. Same pin
  // test/session-manager.test.js keeps on the close verb.
  assert.match(notes[0].body, /\[agent:task accept t1\]/,
    'ENTER: the verb really is in the body, or the assertion below is vacuous');
  for (const line of notes[0].body.split('\n')) {
    assert.ok(!line.startsWith('[agent:'), `no line may START with an intent: ${JSON.stringify(line)}`);
  }
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

test('a merge that fails before it STARTS reports aborted:false but not wedged', async () => {
  // The shape the report has to distinguish, pinned against REAL git rather than
  // asserted from the source: when the merge dies on argument handling, the tree
  // is untouched, `merge --abort` fails too ("There is no merge to abort"), and
  // there is no MERGE_HEAD. `aborted` and `wedged` are therefore NOT complements,
  // which is the whole reason the caller must report off `wedged`.
  const repo = mkRepo();
  commitOnBranch(repo.dir, 'tl-1', 'work.txt', 'the work\n');
  const msg = pathReal.join(repo.dir, 'msg.txt');
  fsReal.writeFileSync(msg, 'merge\n');
  const head = git(repo.dir, ['rev-parse', 'master']);

  const r = await require('../git-worktree').mergeNoFf(repo.dir, 'no-such-branch-anywhere', msg);

  assert.strictEqual(r.ok, false, 'ENTER: the merge really did fail');
  assert.strictEqual(r.aborted, false, 'and `merge --abort` failed too, having nothing to abort');
  assert.strictEqual(r.wedged, false, 'but the checkout is NOT wedged — that is the distinction');
  assert.ok(!/mid-merge/.test(r.error), 'so the error text must not claim a half-applied merge');
  assert.strictEqual(git(repo.dir, ['rev-parse', 'master']), head, 'master did not move');
  assert.ok(!fsReal.existsSync(pathReal.join(repo.dir, '.git', 'MERGE_HEAD')), 'no MERGE_HEAD exists');
});

test('an untouched checkout is never reported to the lead as needing a human', async () => {
  // The caller side of the same claim. `aborted:false` alone would say "the
  // checkout is left mid-merge and needs a human" about a tree git never
  // touched — a false alarm in the one message whose entire job is to be
  // trusted. The stub returns exactly the shape the subject above measured off
  // real git; step 2 rejects an unresolvable branch first, so this arm cannot be
  // reached with a real one.
  const repo = mkRepo();
  commitOnBranch(repo.dir, 'tl-1', 'work.txt', 'the work\n');
  const f = mkMerge({
    repo,
    gitOver: {
      mergeNoFf: async () => ({
        ok: false, sha: null, moved: false, aborted: false, wedged: false, headBefore: null,
        error: "merge: no-such-branch - not something we can merge",
      }),
    },
  });
  const before = f.masterHead();

  await f.m._autoMergeTicket(f.team, 't1', LANDED, ACCEPT);

  const esc = f.esc();
  assert.strictEqual(esc.length, 1, 'ENTER: exactly one escalation');
  assert.match(esc[0].body, /not something we can merge/, 'ENTER: it is the merge failure, not another step');
  assert.ok(!/mid-merge|needs a human/.test(esc[0].body),
    `an untouched tree must not be described as wedged: ${esc[0].body}`);
  assert.strictEqual(f.masterHead(), before, 'and nothing moved');
});

// ── step 5: a red master is undone, never left ─────────────────────────────

test('a suite that goes RED after the merge reverts the merge and escalates', async () => {
  const repo = mkRepo();
  commitOnBranch(repo.dir, 'tl-1', 'work.txt', 'the work\n');
  const f = mkMerge({ repo, suite: 'red' });
  const before = f.masterHead();
  // The twin of the revert-blocked subject above: with NO suite holding the root
  // lock the revert must still happen, or the gate added there would have turned
  // every red merge into an unverified one left on master.
  assert.ok(!fsReal.existsSync(pathReal.join(repo.dir, '.test-digest.lock')),
    'ENTER: nothing holds the root suite lock, so the revert is not gated off');

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

test('a live suite in the root checkout stops the REVERT too, and master keeps the merge', async () => {
  // The merge arm's gate on the revert arm, and the path that reaches it is the
  // one a live suite creates: our post-merge run waits out
  // TICKET_SUITE_LOCK_WAIT_MS for a lock the lead's exec grant holds, the runner
  // dies, `ran` is false — and reverting there rewrites the tree under that
  // still-running child. Today "the suite failed" and "I was never allowed to
  // run it" arrive as the same value.
  //
  // The lock is planted BY THE STUB RUNNER, mid-run: planting it up front would
  // trip the step 3b gate and never merge at all, so the subject would measure
  // suite-in-flight and this arm would go untested.
  const repo = mkRepo();
  commitOnBranch(repo.dir, 'tl-1', 'work.txt', 'the work\n');
  const f = mkMerge({ repo, suite: 'crash' });
  const lock = pathReal.join(repo.dir, '.test-digest.lock');
  const real = f.m._runTicketSuite.bind(f.m);
  f.m._runTicketSuite = async (team, ticket, runIn) => {
    const r = await real(team, ticket, runIn);
    // OUR OWN pid: alive by construction, and the probe harms no process.
    fsReal.mkdirSync(lock, { recursive: true });
    fsReal.writeFileSync(pathReal.join(lock, 'pid'), String(process.pid));
    return r;
  };

  await f.m._autoMergeTicket(f.team, 't1', LANDED, ACCEPT);

  const esc = f.esc();
  assert.strictEqual(esc.length, 1, 'ENTER: exactly one escalation');
  assert.match(esc[0].body, /merge: revert-blocked/, 'named as its own step, not reported as a revert that happened');
  // THE assertion: the merge is STILL THERE. An unverified merge the lead can
  // undo with one command is strictly the lesser harm against a torn write into
  // a running suite.
  assert.match(f.masterLog(), /Merge t1:/, 'the merge is still on master');
  assert.ok(!/Revert/.test(f.masterLog()), 'and nothing reverted it');
  assert.strictEqual(fsReal.readFileSync(pathReal.join(repo.dir, 'work.txt'), 'utf8'), 'the work\n',
    'the branch content is still in the working tree — nothing was rewritten under the running suite');

  // What the lead needs to act: the sha, the pid, and the literal command.
  const sha = git(repo.dir, ['rev-parse', 'master']);
  assert.ok(esc[0].body.includes(sha), 'the escalation names the merge sha');
  assert.match(esc[0].body, new RegExp(String(process.pid)), 'and the pid holding the lock');
  assert.ok(esc[0].body.includes(`git -C ${repo.dir} revert -m 1 ${sha}`),
    'and the exact undo command, mainline included');
  assert.deepStrictEqual(f.landed(), [], 'an unverified merge is never announced as landed');
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

// ── serialization: one merge at a time, and never under a running suite ────

test('a second ACCEPT cannot merge while the first ACCEPT is still running its suite', async () => {
  // THE subject of round 2. Every other test in this file awaits a single call
  // against a millisecond stub, so all of them stay green while two concurrent
  // merges corrupt each other — which is exactly what happened.
  //
  // The window is a real suite (minutes), not a scheduler tick: A merges, blocks
  // in its suite, and B's gates all pass because A's merge left the tree clean
  // and on master. B's merge then rewrites the files under A's running child, so
  // A's result describes A+B and A's revert either conflicts or leaves B merged
  // and never verified.
  //
  // Measured by having the stub runner record master's HEAD AT RUN TIME: that is
  // the tree the suite actually saw, and comparing it to the sha the run was
  // supposed to verify is the corruption, stated directly.
  const repo = mkRepo();
  commitOnBranch(repo.dir, 'tl-1', 'a.txt', 'work a\n');
  git(repo.dir, ['branch', 'tl-2']);
  commitOnBranch(repo.dir, 'tl-2', 'b.txt', 'work b\n');
  const f = mkMerge({ repo });

  // Two tickets, two branches, one root checkout.
  const t1 = f.one('t1');
  f.tstore.save(f.team.root, [t1, {
    ...t1, id: 't2', taskDir: 'tasks/merge-fixture-2',
    spec: 'the second ticket — tasks/merge-fixture-2',
    worktree: { path: pathReal.join(repo.dir, 'wt2'), branch: 'tl-2', baseSha: repo.baseSha },
  }]);

  // A slow suite that reports what master looked like WHILE it ran. The head is
  // read at ENTRY, before the block: that is the tree this run would actually
  // have measured.
  const sawDuringRun = [];
  let release = null;
  let announceEntry = null;
  const held = new Promise((r) => { release = r; });
  // Deterministic, NOT a sleep: a fixed wait for t1's merge is a race against
  // real git, and it lost about half the time — reporting a serialization bug
  // that was not there.
  const firstSuiteEntered = new Promise((r) => { announceEntry = r; });
  let first = true;
  const real = f.m._runTicketSuite.bind(f.m);
  f.m._runTicketSuite = async (team, ticket, runIn) => {
    const mine = first; first = false;
    sawDuringRun.push({ ticket: ticket.id, head: git(repo.dir, ['rev-parse', 'master']) });
    if (mine) { announceEntry(); await held; }
    return real(team, ticket, runIn);
  };

  // Fired the way _handleReviewDone fires them: NOT awaited.
  const p1 = f.m._queueAutoMerge(f.team, 't1', LANDED, ACCEPT);
  const p2 = f.m._queueAutoMerge(f.team, 't2', LANDED, ACCEPT);

  // t1 has now merged and is inside its suite. Give t2 real time to race past it
  // — this sleep can only produce a FALSE PASS if it is too short, never a false
  // failure, because the state it guards is already established.
  await firstSuiteEntered;
  await new Promise((r) => setTimeout(r, 100));
  const headDuringFirstSuite = git(repo.dir, ['rev-parse', 'master']);
  const logDuringFirstSuite = f.masterLog();
  assert.match(logDuringFirstSuite, /Merge t1:/, 'ENTER: t1 really did merge and really is mid-suite, or this measures nothing');
  assert.ok(!/Merge t2:/.test(logDuringFirstSuite),
    'the second merge must NOT land while the first ticket is still verifying its own');

  release();
  await Promise.all([p1, p2]);

  // Both landed in the end — serialized, not dropped.
  assert.deepStrictEqual(f.esc(), [], 'neither merge failed');
  assert.strictEqual(f.landed().length, 2, 'and both were announced');
  const finalLog = f.masterLog();
  assert.match(finalLog, /Merge t1:/);
  assert.match(finalLog, /Merge t2:/);

  // The claim the whole subject exists for: each suite measured the tree its own
  // merge produced, not a tree some other merge had moved underneath it.
  assert.strictEqual(sawDuringRun.length, 2, 'ENTER: both suites ran');
  assert.strictEqual(sawDuringRun[0].head, headDuringFirstSuite,
    'the first suite verified the tree its own merge produced');
  assert.notStrictEqual(sawDuringRun[1].head, sawDuringRun[0].head,
    'and the second ran on a later tree — its own merge, after the first finished');
});

test('two ACCEPTs arriving as review-done are serialized too, not merely when queued directly', async () => {
  // The wiring half of the serialization claim, and it is not redundant: the
  // subject above calls _queueAutoMerge itself, so it stays green against a
  // _handleReviewDone that went back to firing _autoMergeTicket unawaited —
  // which is precisely the shape round 1 shipped. Measured through the real
  // intent path instead.
  const repo = mkRepo();
  commitOnBranch(repo.dir, 'tl-1', 'a.txt', 'work a\n');
  git(repo.dir, ['branch', 'tl-2']);
  commitOnBranch(repo.dir, 'tl-2', 'b.txt', 'work b\n');
  const f = mkMerge({ repo });
  const t1 = f.one('t1');
  f.tstore.save(f.team.root, [t1, {
    ...t1, id: 't2', taskDir: 'tasks/merge-fixture-2',
    spec: 'the second ticket — tasks/merge-fixture-2',
    worktree: { path: pathReal.join(repo.dir, 'wt2'), branch: 'tl-2', baseSha: repo.baseSha },
  }]);

  let release = null;
  let announceEntry = null;
  const held = new Promise((r) => { release = r; });
  const firstSuiteEntered = new Promise((r) => { announceEntry = r; });
  let first = true;
  const real = f.m._runTicketSuite.bind(f.m);
  f.m._runTicketSuite = async (team, ticket, runIn) => {
    const mine = first; first = false;
    if (mine) { announceEntry(); await held; }
    return real(team, ticket, runIn);
  };

  // Two reviewers, two verdicts, delivered the way the reviewer seats deliver
  // them — synchronously, one after the other, neither awaited.
  const r1 = f.reviewer('team-reviewer-1', 't1');
  const r2 = f.reviewer('team-reviewer-2', 't2');
  f.m._handleReviewDone(r1, ACCEPT);
  f.m._handleReviewDone(r2, ACCEPT);

  await firstSuiteEntered;
  await new Promise((r) => setTimeout(r, 100));
  const mid = f.masterLog();
  assert.match(mid, /Merge t1:/, 'ENTER: the first verdict really did drive a merge');
  assert.ok(!/Merge t2:/.test(mid),
    'the second verdict must not merge while the first is still verifying its own');

  release();
  // Drain the chain the intent handler built; there is no promise to await here,
  // which is the whole reason the chain has to live on the manager.
  await f.m._mergeChain;
  assert.match(f.masterLog(), /Merge t2:/, 'and the second lands once the first is done');
  assert.deepStrictEqual(f.esc(), [], 'neither escalated');
});

test('a merge that has to wait for the chain says so in the log', async () => {
  // The chain is process-wide, so a merge wedged on one team stalls every other
  // team's merge for as long as a suite can take — the lock wait alone is 20
  // minutes. Without this line the lead debugging that silence finds nothing at
  // the only place they would look.
  const repo = mkRepo();
  commitOnBranch(repo.dir, 'tl-1', 'a.txt', 'work a\n');
  git(repo.dir, ['branch', 'tl-2']);
  commitOnBranch(repo.dir, 'tl-2', 'b.txt', 'work b\n');
  const f = mkMerge({ repo });
  const t1 = f.one('t1');
  f.tstore.save(f.team.root, [t1, {
    ...t1, id: 't2', taskDir: 'tasks/merge-fixture-2',
    spec: 'the second ticket — tasks/merge-fixture-2',
    worktree: { path: pathReal.join(repo.dir, 'wt2'), branch: 'tl-2', baseSha: repo.baseSha },
  }]);

  const p1 = f.m._queueAutoMerge(f.team, 't1', LANDED, ACCEPT);
  // Read BEFORE awaiting: the line is written at queue time, which is the only
  // moment the wait is knowable — a promise cannot be asked whether it settled.
  const queued = f.logs.filter((l) => /QUEUED/.test(l.msg));
  const p2 = f.m._queueAutoMerge(f.team, 't2', LANDED, ACCEPT);
  const queuedAfter = f.logs.filter((l) => /QUEUED/.test(l.msg));

  assert.deepStrictEqual(queued, [], 'ENTER: the FIRST merge waits for nothing and must not claim to');
  assert.strictEqual(queuedAfter.length, 1, 'the second one logs that it is waiting');
  assert.match(queuedAfter[0].msg, /t2/, 'and names the ticket that is stuck');
  assert.match(queuedAfter[0].msg, /1 merge/, 'and how many are ahead of it');

  await Promise.all([p1, p2]);
  assert.deepStrictEqual(f.esc(), [], 'both merges still landed');
  // The counter must come back to zero on the way out, or every later merge
  // reports a phantom queue for the life of the process.
  assert.strictEqual(f.m._mergePending, 0, 'the in-flight count is not leaked');
});

test('a merge refuses to start while a LIVE pid holds the root suite lock', async () => {
  // The lead's exec grant runs `clodex-run-tests` in the root checkout and holds
  // this lock for minutes. A merge landing mid-run rewrites the files under the
  // running child, and the lead gets a spurious red with nothing naming the
  // cause — suite-lock contention already produced one false rejection here.
  const repo = mkRepo();
  commitOnBranch(repo.dir, 'tl-1', 'work.txt', 'the work\n');
  const f = mkMerge({ repo });
  const before = f.masterHead();
  // OUR OWN pid: alive by construction, and no process is harmed by the probe.
  fsReal.mkdirSync(pathReal.join(repo.dir, '.test-digest.lock'), { recursive: true });
  fsReal.writeFileSync(pathReal.join(repo.dir, '.test-digest.lock', 'pid'), String(process.pid));

  await f.m._autoMergeTicket(f.team, 't1', LANDED, ACCEPT);

  const esc = f.esc();
  assert.strictEqual(esc.length, 1, 'ENTER: exactly one escalation');
  assert.match(esc[0].body, /suite-in-flight/, 'named as its own step, not folded into clean-tree');
  assert.match(esc[0].body, new RegExp(String(process.pid)), 'and it names the pid holding the lock');
  assert.strictEqual(f.masterHead(), before, 'nothing was merged');
  assert.deepStrictEqual(f.landed(), [], 'and no merge was announced');

  // The RECOVERY, and it is the assertion that matters most here: nothing
  // re-drives a merge once its verdict has landed, so an escalation saying "try
  // again later" would describe a mechanism that does not exist and leave the
  // ticket stranded while the lead waits for a retry that never comes.
  assert.match(esc[0].body, /will NOT retry/, 'the lead is told plainly that no retry is coming');
  assert.ok(!/re-run the accept/.test(esc[0].body),
    'and is NOT pointed at a recovery the loop cannot perform');
  // includes, not match: the root is a real tmpdir path and regex-escaping it
  // just to assert a literal is a way to get the assertion itself wrong.
  assert.ok(esc[0].body.includes(`git -C ${repo.dir} merge --no-ff tl-1`),
    'the exact hand-merge command is spelled out, root and branch included');
});

test('a liveness probe that throws stops the merge instead of being read as "nobody"', async () => {
  // The gate's failure direction. A try/catch around the probe would swallow the
  // throw into "no holder", silently disabling the one check that keeps a merge
  // off a checkout with a suite running in it — a gate that fails open is worse
  // than no gate, because the escalation it owes never arrives either.
  const repo = mkRepo();
  commitOnBranch(repo.dir, 'tl-1', 'work.txt', 'the work\n');
  // The injected probe throws, rather than a stubbed _suiteLockHolder: the
  // swallow this pins would live INSIDE that function, so replacing it wholesale
  // would step over the code under test.
  const f = mkMerge({ repo, isAliveOver: () => { throw new Error('probe exploded'); } });
  const before = f.masterHead();
  fsReal.mkdirSync(pathReal.join(repo.dir, '.test-digest.lock'), { recursive: true });
  fsReal.writeFileSync(pathReal.join(repo.dir, '.test-digest.lock', 'pid'), '4242');

  await f.m._autoMergeTicket(f.team, 't1', LANDED, ACCEPT);

  const esc = f.esc();
  assert.strictEqual(esc.length, 1, 'ENTER: exactly one escalation');
  assert.match(esc[0].body, /probe exploded/, 'the throw reaches the lead');
  assert.strictEqual(f.masterHead(), before, 'and nothing was merged');
});

test('a lock naming a DEAD pid is stale and does not block the merge forever', async () => {
  // The runner reclaims a stale lock for exactly this reason: a killed suite
  // never cleans up, and refusing every merge afterwards would be a wedge with
  // no way out and no message.
  const repo = mkRepo();
  commitOnBranch(repo.dir, 'tl-1', 'work.txt', 'the work\n');
  const f = mkMerge({ repo });
  // A pid that has certainly exited: spawn one, wait for it, then use its pid.
  const corpse = require('node:child_process').spawnSync(process.execPath, ['-e', '0']);
  fsReal.mkdirSync(pathReal.join(repo.dir, '.test-digest.lock'), { recursive: true });
  fsReal.writeFileSync(pathReal.join(repo.dir, '.test-digest.lock', 'pid'), String(corpse.pid));
  assert.ok(corpse.pid > 0, 'ENTER: we have a real pid, and it has already exited');

  await f.m._autoMergeTicket(f.team, 't1', LANDED, ACCEPT);

  assert.deepStrictEqual(f.esc(), [], 'a dead holder is not a reason to refuse');
  assert.match(f.masterLog(), /Merge t1:/, 'and the merge went through');
});

// ── the verdict→merge gap ──────────────────────────────────────────────────

test('a ticket reopened between the verdict and the merge is not merged', async () => {
  // The gap is async (an ancestor check, then a whole suite) and the loop
  // re-loads across every other such gap. A `task reject`/`cancel` landing in it
  // reopens the ticket, and merging then lands work the team has just decided is
  // not finished.
  const repo = mkRepo();
  commitOnBranch(repo.dir, 'tl-1', 'work.txt', 'the work\n');
  const f = mkMerge({ repo, ticketOver: { state: 'open' } });
  const before = f.masterHead();
  assert.strictEqual(f.one().state, 'open', 'ENTER: the ticket really is reopened');

  await f.m._autoMergeTicket(f.team, 't1', LANDED, ACCEPT);

  assert.strictEqual(f.masterHead(), before, 'nothing was merged onto master');
  assert.deepStrictEqual(f.landed(), [], 'and nothing was announced');
  // Silent: the lead who reopened it does not need telling that the loop noticed.
  assert.deepStrictEqual(f.esc(), [], 'and it is not escalated either');
});

// ── an escalation the lead never receives ──────────────────────────────────

test('a merge failure is stamped on the ticket, not only sent in a DM', async () => {
  // loopStep is already deleted by the time the merge runs, so ticketInFlight is
  // false and the stall sweep will never look at this ticket again. An
  // escalation whose delivery fails is therefore lost outright — the lead can
  // end up never learning the accept did not land. The board carries what the DM
  // may not.
  const repo = mkRepo();
  commitOnBranch(repo.dir, 'tl-1', 'work.txt', 'the work\n');
  const f = mkMerge({ repo });
  git(repo.dir, ['checkout', '-q', '-b', 'somewhere-else']);
  assert.ok(!('mergeError' in f.one()), 'ENTER: the record starts with no stamp');

  await f.m._autoMergeTicket(f.team, 't1', LANDED, ACCEPT);

  assert.strictEqual(f.one().mergeError, 'on-master',
    'the failing step is on the record, so the board shows it even if the DM never arrived');
});

test('a merge that later succeeds clears an earlier failure off the board', async () => {
  // A stale field on a board is read as current: a ticket that failed at
  // clean-tree, was fixed and then merged must not keep showing the old failure.
  const repo = mkRepo();
  commitOnBranch(repo.dir, 'tl-1', 'work.txt', 'the work\n');
  const f = mkMerge({ repo, ticketOver: { mergeError: 'clean-tree' } });
  assert.strictEqual(f.one().mergeError, 'clean-tree', 'ENTER: a stamp is there to clear');

  await f.m._autoMergeTicket(f.team, 't1', LANDED, ACCEPT);

  assert.deepStrictEqual(f.esc(), [], 'ENTER: this run really did merge');
  assert.ok(!('mergeError' in f.one()), 'the stale failure is gone');
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
  }
  // The staging ban is scoped to git-worktree.js and to argv shapes that could
  // STAGE, not to the two-character string '-A' anywhere in a 9000-line module.
  // A blanket scan fails on any future unrelated flag spelled -A, and the
  // maintainer's cheapest fix for a false alarm is to weaken the pin — so the
  // broad version protects less than the narrow one. git-worktree.js is the only
  // module that assembles git argv at all (session-manager.js reaches git solely
  // through it), which is what makes the narrowing lossless.
  assert.ok(!/'git'|"git"|`git`/.test(sm),
    'ENTER: session-manager.js never invokes git itself, or scoping the -A scan to git-worktree.js misses a site');
  // `['add'` and not `'add',`: git-worktree.js legitimately runs
  // `git worktree add`, which stages nothing. The ban is on argv that BEGINS
  // with add — the staging command — and on the flags that would sweep a
  // sibling seat's uncommitted work into a merge commit.
  assert.ok(!/\['add'/.test(gw), 'git-worktree.js must never git-add — nothing here stages');
  assert.ok(!/'-A'|'--all'/.test(gw), 'git-worktree.js must never stage with -A');
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
