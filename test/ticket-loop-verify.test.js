'use strict';
// Run: node --test test/ticket-loop-verify.test.js
//
// t309 §C/§D/§E — `task done` runs the checks, then spawns the review.
//
// The checks run against a REAL git repo, not a stubbed gitWorktree. The whole
// claim of the verify step is that git agrees the branch is reviewable, and a
// stub proves only that the loop calls the functions it calls — it cannot catch
// the argument-order defect that makes check 2 answer a different question than
// the one it is asked (isMerged(base, branch) vs isMerged(branch, base), which
// differ only in truth value, never in shape).
//
// Three subjects pull in different directions and are asserted separately:
//   1. a green tree reaches the reviewer and nothing reaches the lead
//   2. every red check escalates, spawns NOTHING, and tears NOTHING down
//   3. a `done` ticket the loop still holds stays visible to the watchdog

const { test } = require('node:test');
const assert = require('node:assert');
const fsReal = require('node:fs');
const pathReal = require('node:path');
const osReal = require('node:os');
const { execFileSync } = require('node:child_process');

const { createSessionManager } = require('../session-manager');
const ticketsMod = require('../tickets-store');
const { ticketInFlight } = require('../tickets-store');
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

// The suite CHECK 4 runs is a stub runner planted in the fixture worktree, for
// the reason test/test-digest-lock.test.js gives: a test that shells out to the
// real suite would be the slowest thing in the suite and would recurse.
//
// So these tests pin the loop's CONTRACT WITH the runner — which arm each
// outcome takes — and NOT that the real suite runs. That second claim cannot be
// made here and is not made: it was established by running the real runner in a
// real worktree, and the stub's whole job is to be the runner's output shapes.
//
// The shapes are COPIED FROM A REAL RUN of scripts/run-tests.js against a real
// failing branch, not invented here. That distinction is not pedantry: these
// stubs first used tap's `not ok N - name`, which the loop's parser matched and
// which the runner NEVER prints — it sends tap to a temp file it consumes
// itself, so the only failure text on stdout is the dot reporter's
// `✖ name (1.23ms)` block. The stub agreed with the parser, both were wrong
// together, and every real rejection would have named no tests at all.
// A stub is only evidence when its output came off the real thing.
const SUITE_STUBS = {
  // Exit 0 AND fail 0 — the only shape that reaches a reviewer.
  green: 'console.log("TOTALS: 5 pass, 0 fail, 5 tests");\nprocess.exit(0);\n',
  // A real red run: the dot reporter's failure block, then the summary. The
  // repeated name is real too — the reporter lists each failure inline and again
  // in the trailing summary.
  red: 'console.log(".XX");\nconsole.log("");\nconsole.log("Failed tests:");\nconsole.log("");\n'
    + 'console.log("\\u2716 the thing that broke (1.15ms)");\n'
    + 'console.log("\\u2716 the other thing (0.42ms)");\n'
    + 'console.log("\\u2716 the thing that broke (1.15ms)");\n'
    + 'console.log("TOTALS: 3 pass, 2 fail, 5 tests");\nprocess.exit(1);\n',
  // Exit 0 with failures counted: the escape shape. Neither signal alone catches
  // it, which is why `green` is a conjunction of both.
  escaped: 'console.log("TOTALS: 4 pass, 1 fail, 5 tests");\nprocess.exit(0);\n',
  // A test file that cannot be PARSED. Measured, not assumed: node does not
  // crash the run — it reports the unloadable file as one failing test NAMED BY
  // ITS PATH and still prints a summary. So this is a rejection with the file
  // named, not an escalation, and the hand gets the one thing it needs to fix.
  unloadable: 'console.log("..X");\nconsole.log("");\nconsole.log("Failed tests:");\nconsole.log("");\n'
    + 'console.log("\\u2716 test/unloadable.test.js (46.04ms)");\n'
    + 'console.log("TOTALS: 2 pass, 1 fail, 3 tests");\nprocess.exit(1);\n',
  // Died before it could summarize at all — a refused lock, a runner that could
  // not start, a node crash. NOTHING was verified, so this escalates: the hand
  // cannot fix a run that never happened.
  crash: 'console.error("SyntaxError: Unexpected end of input");\nprocess.exit(1);\n',
  // Ran, exited 0, but never printed a summary. The false green this guards.
  silent: 'process.exit(0);\n',
  // A sweep that discovered NO test files: node prints a valid summary and exits
  // 0, so this satisfies exit-0 and fail-0 both. It is a run that verified
  // nothing, which is the one thing that must never reach a reviewer.
  zerotests: 'console.log("TOTALS: 0 pass, 0 fail, 0 tests");\nprocess.exit(0);\n',
  // A TOTALS-shaped line forwarded from a test file's own output, BEFORE the
  // runner's real summary. Taking the first match reads the wrong numbers off
  // the wrong line — here a green one over a red run.
  shadowed: 'console.log("some test printed: TOTALS: 9 pass, 0 fail, 9 tests");\n'
    + 'console.log("\\u2716 the real failure (2.00ms)");\n'
    + 'console.log("TOTALS: 1 pass, 1 fail, 2 tests");\nprocess.exit(1);\n',
  // A TOTALS-shaped decoy on STDERR. Combining the streams puts all of stderr
  // after all of stdout whenever it was written, so a stderr decoy beats the
  // real summary under any last-match read of the combined text.
  shadowedStderr: 'console.log("\\u2716 the real failure (2.00ms)");\n'
    + 'console.log("TOTALS: 1 pass, 1 fail, 2 tests");\n'
    + 'console.error("a test printed: TOTALS: 9 pass, 0 fail, 9 tests");\n'
    + 'process.exit(1);\n',
  // Never exits on its own — the kill arm — and SPAWNS A GRANDCHILD, which is
  // what the real runner does (it blocks in spawnSync running `node --test`,
  // which starts a file per test). The grandchild writes a marker while alive
  // and is the thing a runner-only kill would orphan.
  //
  // Self-terminating at 60s despite "never exits": node:test's default per-test
  // timeout is infinite, so a fixture that truly loops forever turns a failed
  // mutation into a WEDGED SUITE instead of a red subject. A fixture must never
  // outlive the run that spawned it.
  // The grandchild self-terminates too, and for a stronger reason than its
  // parent: this one is DESIGNED to be orphaned, so when the kill regresses it
  // is the process that survives with nothing left to reap it. Measured — two
  // mutation runs left two of them running until killed by hand.
  // It writes the marker ONCE immediately and only then installs the interval:
  // the ENTER downstream needs the marker to EXIST before the kill, and making
  // that wait a 50ms tick puts a whole scheduling quantum between the fixture
  // and the assertion for no gain.
  hang: 'const { spawn } = require("child_process");\n'
    + 'const kid = spawn(process.execPath, ["-e",\n'
    + '  "const fs=require(\'fs\');const w=()=>{try{fs.writeFileSync(process.env.T317_KID,String(Date.now()));}catch{}};w();setInterval(w,50);"\n'
    + '  + "setTimeout(()=>process.exit(0),60000);"\n'
    + '], { stdio: "ignore" });\n'
    + 'console.log("TOTALS: 5 pass, 0 fail, 5 tests");\n'
    + 'setTimeout(() => process.exit(0), 60000);\n'
    + 'setInterval(() => {}, 1000);\n',
};

// Plants the worktree the loop runs in: the branch's own scripts/run-tests.js,
// plus the node_modules the symlink step looks for at the team root.
function stubSuite(repo, mode) {
  const wt = pathReal.join(repo.dir, 'wt');
  fsReal.mkdirSync(pathReal.join(wt, 'scripts'), { recursive: true });
  fsReal.mkdirSync(pathReal.join(repo.dir, 'node_modules'), { recursive: true });
  if (mode === 'none') return wt;
  fsReal.writeFileSync(pathReal.join(wt, 'scripts', 'run-tests.js'), SUITE_STUBS[mode]);
  return wt;
}

// A real repo with a base commit and a branch carrying one commit beyond it —
// the shape the loop is designed for. Returned SHAs are read back from git, not
// assumed, so a fixture that failed to build the state it names cannot pass.
function mkRepo() {
  const dir = fsReal.mkdtempSync(pathReal.join(osReal.tmpdir(), 'clodex-loop-repo-'));
  git(dir, ['init', '-q', '-b', 'master']);
  git(dir, ['config', 'user.email', 't@t.t']);
  git(dir, ['config', 'user.name', 'T']);
  fsReal.writeFileSync(pathReal.join(dir, 'base.txt'), 'base\n');
  git(dir, ['add', 'base.txt']);
  git(dir, ['commit', '-q', '-m', 'base']);
  const baseSha = git(dir, ['rev-parse', 'HEAD']);
  git(dir, ['branch', 'tl-1']);
  return { dir, baseSha };
}

// One commit on the ticket's branch. Written through git so the diff the loop
// materializes is a real diff of real content.
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

// `suite` defaults to 'green' so the subjects that predate CHECK 4 keep
// measuring what they were written to measure. A fixture with no runner would
// escalate at the suite check, and every green-path assertion downstream would
// silently become an assertion about that escalation instead.
function mkLoop({
  repo, ticketOver = {}, noLeadSession = false, noReviewerPrompt = false, suite = 'green',
  suiteTimeoutMs = null,
} = {}) {
  stubSuite(repo, suite);
  const home = fsReal.mkdtempSync(pathReal.join(osReal.tmpdir(), 'clodex-loop-'));
  // The reviewer's role prompt must EXIST, because the spawn path warns when it
  // does not and the loop escalates on that warning. Without this the fixture
  // models a box with no prompts installed, and every green-path assertion below
  // would be measuring the unbriefed escalation instead of the review.
  if (!noReviewerPrompt) {
    const pdir = pathReal.join(home, 'library', 'prompts', 'system');
    fsReal.mkdirSync(pdir, { recursive: true });
    fsReal.writeFileSync(pathReal.join(pdir, 'clodex-team-reviewer.md'), '# reviewer\n');
  }
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
    // The REAL module, deliberately: see the header. A stub here would assert
    // only that the loop calls the functions it calls.
    gitWorktree: require('../git-worktree'),
    // REAL child_process, like gitWorktree above and for the same reason: the
    // suite check's claim is that a runner actually executed and its exit code
    // was read, and a stubbed spawn proves only that the loop called spawn. The
    // thing being executed is a stub script; the execution is genuine.
    childProcess: require('node:child_process'),
    // Left unset for every other subject, so they exercise the SHIPPED cap
    // rather than a fixture-only one; only the hang subject overrides it.
    ...(suiteTimeoutMs == null ? {} : { ticketSuiteTimeoutMs: suiteTimeoutMs }),
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
  // onWrite is INVOKED, not dropped: the watchdog's nudge stamp rides it (the
  // real queue calls it when the delivery is written), so a stub that ignores it
  // models a system where no stall episode is ever stamped — under which the
  // one-nudge-per-episode assertions below would fail for a reason that exists
  // only in the fixture.
  m._gatedDeliver = (target, sender, body, urgent, tag, onWrite) => {
    gated.push({ target, sender, body });
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
  if (!noLeadSession) seat('lead');
  seat('team-hand');

  // The ticket is written directly rather than through add/start: `start` mints a
  // real worktree via git, and these subjects are about the checks that run after
  // a tree already exists. The worktree block carries what the loop reads.
  const ticket = {
    id: 't1', state: 'open', spec: 'the spec — tasks/loop-fixture', taskDir: 'tasks/loop-fixture',
    assignee: 'team-hand', role: 'hand', openedAt: Date.now(), lastActivityAt: Date.now(),
    startedAt: Date.now(),
    worktree: { path: pathReal.join(repo.dir, 'wt'), branch: 'tl-1', baseSha: repo.baseSha },
    ...ticketOver,
  };
  tstore.save(team.root, [ticket]);

  return {
    m, team, home, tstore, persistence, injected, gated, broadcasts, created, seat,
    one: (id = 't1') => tstore.load(team.root).find((t) => t.id === id),
    esc: () => gated.filter((g) => /ESCALATED/.test(g.body)),
    diffFile: () => {
      const p = pathReal.join(home, 'projects');
      const hits = [];
      const walk = (d) => {
        let ents = [];
        try { ents = fsReal.readdirSync(d, { withFileTypes: true }); } catch { return; }
        for (const e of ents) {
          const full = pathReal.join(d, e.name);
          if (e.isDirectory()) walk(full); else if (e.name.endsWith('.diff')) hits.push(full);
        }
      };
      walk(p);
      return hits;
    },
  };
}

// ── the green path ─────────────────────────────────────────────────────────

test('a branch with a commit passes every check and reaches a reviewer, not the lead', async () => {
  const repo = mkRepo();
  commitOnBranch(repo.dir, 'tl-1', 'work.txt', 'the work\n');
  const f = mkLoop({ repo });
  f.tstore.save(f.team.root, [{ ...f.one(), state: 'done', loopStep: 'verify', report: 'I did the work. Suite green at 4999.', reportedBy: 'team-hand' }]);
  assert.strictEqual(f.one().loopStep, 'verify', 'ENTER: the loop holds the ticket at verify');

  await f.m._runTicketLoop(f.team, 't1');
  // The spawn runs inside _handleTeamReview's setImmediate, and so does every
  // escalation it can raise (a refused spawn, an UNBRIEFED reviewer). Asserting
  // before draining the microtask queue measures a window in which NO spawn-time
  // escalation exists yet, so `esc() === []` would hold even if every spawn
  // escalated. This is the exact shape that hid the missing reviewer prompt in
  // round 1 — the assertion passed by being early, not by being right.
  await new Promise((r) => setImmediate(r));

  assert.deepStrictEqual(f.esc(), [], 'a green tree must not reach the lead at all');
  const rec = f.persistence.list().find((e) => e.reviewTicket === 't1');
  assert.ok(rec, 'a reviewer seat must be reserved, carrying reviewTicket');
  assert.strictEqual(rec.reviewFor, 'lead', 'reviewFor still identifies the seat');
  assert.strictEqual(f.one().loopStep, 'review', 'the ticket advances to the review step');
});

test('the materialized diff is written, non-empty, and named in the scope', async () => {
  const repo = mkRepo();
  commitOnBranch(repo.dir, 'tl-1', 'work.txt', 'the work\n');
  const f = mkLoop({ repo });
  f.tstore.save(f.team.root, [{ ...f.one(), state: 'done', loopStep: 'verify', report: 'r', reportedBy: 'team-hand' }]);

  await f.m._runTicketLoop(f.team, 't1');
  await new Promise((r) => setImmediate(r));

  const diffs = f.diffFile();
  assert.strictEqual(diffs.length, 1, 'exactly one diff file is materialized');
  // The round is in the name so round 2 cannot overwrite round 1's artifact.
  assert.strictEqual(pathReal.basename(diffs[0]), 'review-t1-r1.diff');
  const body = fsReal.readFileSync(diffs[0], 'utf8');
  // The real content, not merely non-empty: an empty-but-present file would
  // satisfy a length check and give the reviewer nothing.
  assert.match(body, /\+the work/, 'the diff carries the added line');
  assert.match(body, /work\.txt/);
});

test('the reviewer is spawned with the constructed scope, carrying the report verbatim', async () => {
  const repo = mkRepo();
  commitOnBranch(repo.dir, 'tl-1', 'work.txt', 'the work\n');
  const f = mkLoop({ repo });
  const REPORT = 'Changed work.txt. Suite green at 4999. I GUESSED the retry bound.';
  f.tstore.save(f.team.root, [{ ...f.one(), state: 'done', loopStep: 'verify', report: REPORT, reportedBy: 'team-hand' }]);

  await f.m._runTicketLoop(f.team, 't1');
  await new Promise((r) => setImmediate(r));

  assert.strictEqual(f.created.length, 1, 'ENTER: exactly one reviewer was created');
  const prompt = f.created[0].systemPrompt;
  assert.ok(prompt.includes(REPORT), "the hand's report rides the scope verbatim");
  assert.ok(prompt.includes(repo.baseSha + '..HEAD'), 'the review range is in the scope');
  assert.ok(prompt.includes('review-t1-r1.diff'), 'the diff path is in the scope');
  assert.ok(prompt.includes('VERDICT'), 'the verdict grammar is in the scope');
});

test('--text keeps a NUL-containing file reviewable instead of "Binary files differ"', async () => {
  // The spec calls --text mandatory and not style, and this is why: git decides
  // binary-ness from content, so ONE NUL byte in a source file collapses the
  // whole file's hunks to a single "Binary files differ" line. A reviewer then
  // reviews nothing while truthfully reporting that it read the diff — a silent
  // failure no other assertion in this file can see, because the diff is still
  // non-empty and every check still passes.
  const repo = mkRepo();
  const cur = git(repo.dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
  git(repo.dir, ['checkout', '-q', 'tl-1']);
  // A REAL NUL, written as an escape: a raw NUL in this source would not survive
  // an editor, a grep, or a perl pass that treats it as a record separator — and
  // a fixture that silently loses its NUL still passes while testing nothing.
  const withNul = 'before\u0000after\nthe real change\n';
  assert.ok(withNul.includes('\u0000'), 'ENTER: the fixture really contains a NUL byte');
  fsReal.writeFileSync(pathReal.join(repo.dir, 'nul.txt'), withNul);
  git(repo.dir, ['add', 'nul.txt']);
  git(repo.dir, ['commit', '-q', '-m', 'nul']);
  git(repo.dir, ['checkout', '-q', cur]);

  const gw = require('../git-worktree');
  const r = await gw.diffText(repo.dir, repo.baseSha, 'tl-1');

  assert.strictEqual(r.ok, true);
  assert.ok(!/Binary files/.test(r.text), 'the diff must not degrade to a binary stub');
  assert.match(r.text, /\+the real change/, 'the added line is readable in the diff');
});

// ── the red paths ──────────────────────────────────────────────────────────

test('zero commits on the branch escalates and spawns nothing', async () => {
  const repo = mkRepo();   // tl-1 exists but carries no commit beyond base
  const f = mkLoop({ repo });
  f.tstore.save(f.team.root, [{ ...f.one(), state: 'done', loopStep: 'verify', report: 'r', reportedBy: 'team-hand' }]);

  await f.m._runTicketLoop(f.team, 't1');
  await new Promise((r) => setImmediate(r));

  const esc = f.esc();
  assert.strictEqual(esc.length, 1, 'exactly one escalation — one channel, one message');
  assert.strictEqual(esc[0].target, 'lead');
  assert.match(esc[0].body, /commits-on-branch/, 'the escalation names the failing check');
  assert.match(esc[0].body, /0 commits beyond/, 'the escalation carries the actual evidence');
  assert.strictEqual(f.created.length, 0, 'no reviewer may be spawned on a red check');
  assert.strictEqual(f.persistence.list().filter((e) => e.reviewTicket).length, 0);
});

test('a base that is no longer an ancestor escalates, naming that check', async () => {
  const repo = mkRepo();
  commitOnBranch(repo.dir, 'tl-1', 'work.txt', 'the work\n');
  const f = mkLoop({ repo });
  // An orphan commit: a real sha, reachable from nothing on tl-1 — exactly the
  // post-rebase state where the base the spec was written against is gone.
  const orphan = execFileSync('git', ['-C', repo.dir, 'commit-tree', `${repo.baseSha}^{tree}`, '-m', 'orphan'], { encoding: 'utf8' }).trim();
  const t = f.one();
  f.tstore.save(f.team.root, [{ ...t, state: 'done', loopStep: 'verify', report: 'r', reportedBy: 'team-hand', worktree: { ...t.worktree, baseSha: orphan } }]);

  await f.m._runTicketLoop(f.team, 't1');
  await new Promise((r) => setImmediate(r));

  const esc = f.esc();
  assert.strictEqual(esc.length, 1);
  assert.match(esc[0].body, /base-is-ancestor/, 'the escalation names the ancestry check, not the commit check');
  assert.match(esc[0].body, /NOT an ancestor/);
  assert.strictEqual(f.created.length, 0);
});

test('check 2 asks whether the BASE is contained in the branch, not the reverse', async () => {
  // The argument-order pin. With isMerged's arguments swapped, this fixture —
  // a healthy branch one commit ahead — reports "already merged into its base"
  // and the loop would escalate a perfectly good tree. Only truth values differ
  // between the two calls, so nothing but a real repo catches it.
  const repo = mkRepo();
  commitOnBranch(repo.dir, 'tl-1', 'work.txt', 'the work\n');
  const gw = require('../git-worktree');
  const right = await gw.isMerged(repo.dir, repo.baseSha, 'tl-1');
  const wrong = await gw.isMerged(repo.dir, 'tl-1', repo.baseSha);
  assert.strictEqual(right.merged, true, 'the base IS an ancestor of the branch — the question the loop must ask');
  assert.strictEqual(wrong.merged, false, 'the swapped question answers differently on the same healthy tree');
});

test('an empty diff escalates rather than reaching a reviewer with nothing to read', async () => {
  const repo = mkRepo();
  // A commit that changes no content: rev-list counts it, git diff is empty.
  // This is the case check 1 cannot see and check 3 exists for.
  const cur = git(repo.dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
  git(repo.dir, ['checkout', '-q', 'tl-1']);
  git(repo.dir, ['commit', '-q', '--allow-empty', '-m', 'empty']);
  git(repo.dir, ['checkout', '-q', cur]);
  const f = mkLoop({ repo });
  f.tstore.save(f.team.root, [{ ...f.one(), state: 'done', loopStep: 'verify', report: 'r', reportedBy: 'team-hand' }]);

  await f.m._runTicketLoop(f.team, 't1');
  await new Promise((r) => setImmediate(r));

  const esc = f.esc();
  assert.strictEqual(esc.length, 1);
  assert.match(esc[0].body, /verify: diff/);
  assert.match(esc[0].body, /is empty despite 1 commit/, 'the evidence names the contradiction it found');
  assert.strictEqual(f.created.length, 0);
});

test('escalation tears nothing down and clears the loop hold', async () => {
  const repo = mkRepo();
  const f = mkLoop({ repo });
  f.tstore.save(f.team.root, [{ ...f.one(), state: 'done', loopStep: 'verify', report: 'r', reportedBy: 'team-hand' }]);

  await f.m._runTicketLoop(f.team, 't1');

  const t = f.one();
  // The tree, the branch and the seat are what the lead looks at first.
  assert.deepStrictEqual(t.worktree, { path: pathReal.join(repo.dir, 'wt'), branch: 'tl-1', baseSha: repo.baseSha },
    'the worktree record is untouched by an escalation');
  assert.ok(f.m.sessions.has('team-hand'), 'the hand seat survives an escalation');
  assert.strictEqual(t.state, 'done', 'the escalation does not reopen or cancel the ticket');
  assert.ok(!('loopStep' in t), 'the loop no longer holds a ticket it handed to a human');
  assert.match(f.esc()[0].body, /Nothing was torn down/);
});

test('an escalation the lead never RECEIVED keeps the hold, so the watchdog re-surfaces it', async () => {
  // The fixture's default stub returns {queued:true} unconditionally, which pins
  // that escalate was CALLED, not that the lead was REACHED. _gatedDeliver really
  // returns {error} when the lead has no live session. Clearing the hold before
  // reading that is how a ticket nobody is ever told about is produced: no
  // reviewer was spawned, the sweep can no longer see it, and the only trace is
  // a log line.
  const repo = mkRepo();
  const f = mkLoop({ repo });   // zero commits -> check 1 fails -> escalation
  f.m._gatedDeliver = (target, sender, body) => { f.gated.push({ target, sender, body }); return { error: 'no such agent "lead"' }; };
  f.tstore.save(f.team.root, [{ ...f.one(), state: 'done', loopStep: 'verify', report: 'r', reportedBy: 'team-hand' }]);

  await f.m._runTicketLoop(f.team, 't1');

  assert.strictEqual(f.one().loopStep, 'verify', 'an undelivered escalation must NOT release the hold');
  // And the hold is what keeps it visible: the sweep must still nudge it.
  f.gated.length = 0;
  f.m._gatedDeliver = (target, sender, body, urgent, tag, onWrite) => {
    f.gated.push({ target, sender, body });
    if (typeof onWrite === 'function') onWrite();
    return { queued: true };
  };
  const old = Date.now() - (60 * 60 * 1000);
  const t = f.one();
  f.tstore.save(f.team.root, [{ ...t, lastActivityAt: old, nudgedAt: null }]);
  f.m._sweepTeamTickets(f.team, Date.now());

  const nudges = f.gated.filter((g) => g.sender === 'ticket-watchdog');
  assert.strictEqual(nudges.length, 1, 'the ticket is still in flight and still nudgeable');
});

test('a HELD delivery that never parked also keeps the hold', async () => {
  // The second reachable failure: shouldHoldDm holds and the target cannot park
  // (a codex lead, or one _dead mid-restart), so _gatedDeliver returns {held}
  // with no parkId — nobody was reached. A park IS durable and does count.
  const repo = mkRepo();
  const f = mkLoop({ repo });
  f.m._gatedDeliver = (target, sender, body) => { f.gated.push({ target, sender, body }); return { held: 'busy' }; };
  f.tstore.save(f.team.root, [{ ...f.one(), state: 'done', loopStep: 'verify', report: 'r', reportedBy: 'team-hand' }]);

  await f.m._runTicketLoop(f.team, 't1');

  assert.strictEqual(f.one().loopStep, 'verify', 'a held-but-unparked escalation reached nobody');
});

test('a PARKED escalation is durable, so it does release the hold', async () => {
  const repo = mkRepo();
  const f = mkLoop({ repo });
  f.m._gatedDeliver = (target, sender, body) => { f.gated.push({ target, sender, body }); return { parked: 'park-1' }; };
  f.tstore.save(f.team.root, [{ ...f.one(), state: 'done', loopStep: 'verify', report: 'r', reportedBy: 'team-hand' }]);

  await f.m._runTicketLoop(f.team, 't1');

  assert.ok(!('loopStep' in f.one()), 'a park is a written file the seat drains — the lead will get it');
});

test('closing a ticket that was already nudged starts a fresh stall episode', async () => {
  // The MF2 interleaving: seat goes quiet, watchdog stamps nudgedAt, the lead
  // closes for the dead hand (a path _taskDone explicitly supports), verify then
  // dies. Nothing outside the loop can clear nudgedAt after `done`
  // (_touchTicketActivity skips anything not open), so without a clear at the
  // stamp site the sweep sees an in-flight ticket it refuses to nudge, forever.
  const repo = mkRepo();
  commitOnBranch(repo.dir, 'tl-1', 'work.txt', 'the work\n');
  const f = mkLoop({ repo });
  const old = Date.now() - (60 * 60 * 1000);
  f.tstore.save(f.team.root, [{ ...f.one(), lastActivityAt: old, nudgedAt: Date.now() }]);
  assert.ok(f.one().nudgedAt, 'ENTER: the ticket enters already nudged');

  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'done', id: 't1', who: null, body: 'closing for the dead hand' });

  assert.strictEqual(f.one().nudgedAt, null, 'opening an in-flight phase spends a fresh nudge');

  // And prove the consequence, not just the field: a stalled sweep still fires.
  const t = f.one();
  f.tstore.save(f.team.root, [{ ...t, loopStep: 'verify', lastActivityAt: old, nudgedAt: null }]);
  f.gated.length = 0;
  f.m._sweepTeamTickets(f.team, Date.now());
  const nudges = f.gated.filter((g) => g.sender === 'ticket-watchdog');
  assert.strictEqual(nudges.length, 1, 'a dead verify step is still surfaced');
});

test('accept clears the hold, so a late verdict cannot land on torn-down work', async () => {
  // The MF3 interleaving: the lead accepts before the verdict returns, which
  // retires the seat, removes the worktree and deletes the branch. A surviving
  // loopStep would let the late verdict through, stamping a REWORK with a bumped
  // reviewRound onto merged-and-deleted work while telling the lead nothing.
  const repo = mkRepo();
  commitOnBranch(repo.dir, 'tl-1', 'work.txt', 'the work\n');
  const f = mkLoop({ repo });
  f.tstore.save(f.team.root, [{ ...f.one(), state: 'done', loopStep: 'review' }]);
  f.m.destroy = async () => ({ ok: true, worktreeRemoved: true });
  f.m.archive = async () => {};

  await f.m._taskAccept(f.seat('lead'), f.team, { type: 'task', sub: 'accept', id: 't1', body: '' }, () => {});

  const t = f.one();
  assert.ok(t.acceptedAt, 'ENTER: the ticket really was accepted');
  assert.ok(!('loopStep' in t), 'accept ends the loop hold');

  // The consequence: the late verdict now falls through to the lead instead.
  const landed = f.m._landVerdictOnTicket(f.seat('rev', repo.dir), 't1', '- **VERDICT**: REWORK\n- **MUST-FIX**: too late');
  assert.strictEqual(landed, null, 'a verdict cannot be placed on an accepted ticket');
  assert.ok(!('verdict' in f.one()), 'and nothing was stamped onto it');
});

test('reject clears the hold too', () => {
  const repo = mkRepo();
  const f = mkLoop({ repo });
  f.tstore.save(f.team.root, [{ ...f.one(), state: 'done', loopStep: 'review' }]);

  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'reject', id: 't1', who: null, body: 'fix the bound' });

  const t = f.one();
  assert.strictEqual(t.state, 'open', 'ENTER: the ticket really was reopened');
  assert.ok(!('loopStep' in t), 'a reopened ticket is tracked on the ordinary path, not as loop-held');
});

test('an unbriefed reviewer escalates rather than reviewing nothing', async () => {
  // The spawn SUCCEEDS but warns the seat booted without its role prompt, so it
  // does not know the verdict grammar or that it must emit one. That arrives on
  // the success reply, which the error branch never sees.
  const repo = mkRepo();
  commitOnBranch(repo.dir, 'tl-1', 'work.txt', 'the work\n');
  const f = mkLoop({ repo, noReviewerPrompt: true });
  f.tstore.save(f.team.root, [{ ...f.one(), state: 'done', loopStep: 'verify', report: 'r', reportedBy: 'team-hand' }]);

  await f.m._runTicketLoop(f.team, 't1');
  await new Promise((r) => setImmediate(r));

  const esc = f.esc();
  assert.strictEqual(esc.length, 1, 'the lead is told the review will not happen');
  assert.match(esc[0].body, /boots UNBRIEFED/);
});

test('a throw AFTER the record advanced escalates as "review", not as "verify"', async () => {
  // The catch-all reports which half of the loop stopped, and the lead's first
  // act is to go look at it. Reporting a literal `verify` after the record
  // already says `review` sends them to the wrong half — and the record is the
  // thing they would check the claim against, so the two disagree.
  const repo = mkRepo();
  commitOnBranch(repo.dir, 'tl-1', 'work.txt', 'the work\n');
  const f = mkLoop({ repo });
  f.tstore.save(f.team.root, [{ ...f.one(), state: 'done', loopStep: 'verify', report: 'r', reportedBy: 'team-hand' }]);
  f.m._spawnTicketReview = () => { throw new Error('spawn exploded'); };

  await f.m._runTicketLoop(f.team, 't1');
  await new Promise((r) => setImmediate(r));

  const esc = f.esc();
  assert.strictEqual(esc.length, 1, 'ENTER: the catch-all escalated exactly once');
  assert.match(esc[0].body, /spawn exploded/, 'ENTER: it is the throw, not another arm');
  assert.match(esc[0].body, /stopped at: review/,
    'the step reported must be the step the record is actually at');
  assert.ok(!/stopped at: verify/.test(esc[0].body),
    'reporting verify here contradicts the record and sends the lead to the wrong half');
});

test('the UNBRIEFED escalation KEEPS the hold, because the seat can still answer', async () => {
  // The other escalation arms release the hold once the lead has been told, and
  // that is right for them: nothing is left running. This arm is different — the
  // seat spawned and carries reviewTicket. Releasing here makes the ticket
  // not-in-flight, so a verdict that seat later emits fails
  // _landVerdictOnTicket's guard and is never recorded: no verdict, no mustFix,
  // reviewRound stuck at 0, and a later round 2 announcing itself as round 1.
  const repo = mkRepo();
  commitOnBranch(repo.dir, 'tl-1', 'work.txt', 'the work\n');
  const f = mkLoop({ repo, noReviewerPrompt: true });
  f.tstore.save(f.team.root, [{ ...f.one(), state: 'done', loopStep: 'verify', report: 'r', reportedBy: 'team-hand' }]);

  await f.m._runTicketLoop(f.team, 't1');
  await new Promise((r) => setImmediate(r));

  assert.strictEqual(f.esc().length, 1, 'ENTER: the UNBRIEFED arm is the one that fired');
  const t = f.one();
  assert.strictEqual(t.loopStep, 'review', 'the hold stays, at the step the reviewer is at');
  assert.strictEqual(ticketInFlight(t), true,
    'in-flight is the property that actually matters: it is what lets a verdict land');
});

test('an escalation with no live seat behind it still RELEASES the hold', async () => {
  // The converse of the test above, and the reason keepHold is an opt-in rather
  // than the default: a verify-stage failure spawns nobody, so nothing can ever
  // land a verdict on that ticket. Holding it there would leave the sweep
  // nudging the lead about a loop that has already reported and stopped.
  const repo = mkRepo();
  const f = mkLoop({ repo });   // no commit on the branch: CHECK 1 fails
  f.tstore.save(f.team.root, [{ ...f.one(), state: 'done', loopStep: 'verify', report: 'r', reportedBy: 'team-hand' }]);

  await f.m._runTicketLoop(f.team, 't1');
  await new Promise((r) => setImmediate(r));

  assert.strictEqual(f.esc().length, 1, 'ENTER: the verify arm escalated');
  const t = f.one();
  assert.ok(!('loopStep' in t) || t.loopStep == null,
    'a delivered escalation with nothing left running releases the hold');
  assert.strictEqual(ticketInFlight(t), false, 'the ticket is finished with the lead');
});

test('the nudge for a loop-held ticket names the STEP, not the finished hand', () => {
  const repo = mkRepo();
  const f = mkLoop({ repo });
  const old = Date.now() - (60 * 60 * 1000);
  f.tstore.save(f.team.root, [{ ...f.one(), state: 'done', loopStep: 'review', lastActivityAt: old, nudgedAt: null }]);

  f.m._sweepTeamTickets(f.team, Date.now());

  const nudges = f.gated.filter((g) => g.sender === 'ticket-watchdog');
  assert.strictEqual(nudges.length, 1, 'ENTER: the in-flight ticket was nudged');
  // "hand quiet 45m" points at the wrong actor: the hand already reported.
  assert.match(nudges[0].body, /loop is stuck at "review"/);
  assert.ok(!/team-hand quiet/.test(nudges[0].body), 'the finished seat must not be blamed');
});

test('a spawn refusal becomes an escalation, never silence', async () => {
  const repo = mkRepo();
  commitOnBranch(repo.dir, 'tl-1', 'work.txt', 'the work\n');
  const f = mkLoop({ repo });
  // No reviewer role: _handleTeamReview refuses with an `error:` reply. Diverted
  // by onReply, that reply must resurface as an escalation — a swallowed refusal
  // leaves a ticket marked under review with no reviewer in existence.
  delete f.team.roles.reviewer;
  f.tstore.save(f.team.root, [{ ...f.one(), state: 'done', loopStep: 'verify', report: 'r', reportedBy: 'team-hand' }]);

  await f.m._runTicketLoop(f.team, 't1');
  await new Promise((r) => setImmediate(r));

  const esc = f.esc();
  assert.strictEqual(esc.length, 1, 'the refusal reaches the lead exactly once');
  assert.match(esc[0].body, /review: spawn/);
  assert.match(esc[0].body, /no "reviewer" role/, 'the escalation carries the refusal verbatim as evidence');
  assert.strictEqual(f.created.length, 0);
});

test("the loop's spawn reply does not print in the lead's terminal", async () => {
  const repo = mkRepo();
  commitOnBranch(repo.dir, 'tl-1', 'work.txt', 'the work\n');
  const f = mkLoop({ repo });
  f.tstore.save(f.team.root, [{ ...f.one(), state: 'done', loopStep: 'verify', report: 'r', reportedBy: 'team-hand' }]);

  await f.m._runTicketLoop(f.team, 't1');
  await new Promise((r) => setImmediate(r));

  // Escalation is the only path to the lead; a "spawned team-reviewer-1" notice
  // injected into the lead is the second path the design forbids.
  const spawnNotices = f.injected.filter((s) => /team-review/.test(s));
  assert.deepStrictEqual(spawnNotices, [], 'no team-review reply may be injected into the lead');
});

test('a dead lead escalates instead of throwing into the void', async () => {
  const repo = mkRepo();
  commitOnBranch(repo.dir, 'tl-1', 'work.txt', 'the work\n');
  const f = mkLoop({ repo, noLeadSession: true });
  f.tstore.save(f.team.root, [{ ...f.one(), state: 'done', loopStep: 'verify', report: 'r', reportedBy: 'team-hand' }]);

  await f.m._runTicketLoop(f.team, 't1');

  const esc = f.esc();
  assert.strictEqual(esc.length, 1);
  assert.match(esc[0].body, /no live session to spawn a reviewer from/);
});

test('the loop refuses to re-drive a ticket it no longer holds', async () => {
  const repo = mkRepo();
  commitOnBranch(repo.dir, 'tl-1', 'work.txt', 'the work\n');
  const f = mkLoop({ repo });
  // No loopStep: another path (a verdict, a cancel) owns it now. Re-driving
  // would put a second reviewer on one ticket.
  f.tstore.save(f.team.root, [{ ...f.one(), state: 'done', report: 'r', reportedBy: 'team-hand' }]);

  await f.m._runTicketLoop(f.team, 't1');
  await new Promise((r) => setImmediate(r));

  assert.strictEqual(f.created.length, 0, 'no reviewer for a ticket the loop does not hold');
  assert.deepStrictEqual(f.esc(), [], 'and no escalation either — this is not an error, it is a hand-off');
});

// ── §A: the report is persisted, not only delivered ────────────────────────

test('task done persists the report AND delivers it to the lead', () => {
  const repo = mkRepo();
  commitOnBranch(repo.dir, 'tl-1', 'work.txt', 'the work\n');
  const f = mkLoop({ repo });
  const REPORT = 'did the thing; suite green at 4999; guessed the bound';

  f.m._handleTask(f.seat('team-hand'), { type: 'task', sub: 'done', id: 't1', who: null, body: REPORT });

  const t = f.one();
  assert.strictEqual(t.report, REPORT, 'the full report is on the record, verbatim');
  assert.strictEqual(t.reportedBy, 'team-hand', 'and the seat that closed it');
  // BOTH, not either: the delivery is what reaches the lead now, the record is
  // what survives the message and feeds the review scope.
  const delivered = f.gated.filter((g) => g.target === 'lead' && g.body.includes(REPORT));
  assert.strictEqual(delivered.length, 1, 'the lead delivery is unchanged');
});

test('task done stamps loopStep in the same write that closes the ticket', () => {
  const repo = mkRepo();
  commitOnBranch(repo.dir, 'tl-1', 'work.txt', 'the work\n');
  const f = mkLoop({ repo });

  f.m._handleTask(f.seat('team-hand'), { type: 'task', sub: 'done', id: 't1', who: null, body: 'r' });

  const t = f.one();
  assert.strictEqual(t.state, 'done');
  // Same write: a process that died between the close and a later stamp would
  // leave a done ticket nothing ever nudges.
  assert.ok(t.loopStep, 'a worktree ticket is held by the loop the moment it closes');
});

test('task done actually DRIVES the loop, not merely marks it', async () => {
  // The wiring pin. Every other loop test calls _runTicketLoop directly, so all
  // of them stay green if `task done` never fires it — the ticket would sit at
  // loopStep 'verify' forever, waiting on a step nothing runs, and only the
  // watchdog would ever notice.
  const repo = mkRepo();
  commitOnBranch(repo.dir, 'tl-1', 'work.txt', 'the work\n');
  const f = mkLoop({ repo });

  f.m._handleTask(f.seat('team-hand'), { type: 'task', sub: 'done', id: 't1', who: null, body: 'did it; suite green at 4999' });
  // The loop is fired unawaited from a sync handler, so let its git calls settle.
  for (let i = 0; i < 40 && f.created.length === 0; i++) await new Promise((r) => setTimeout(r, 25));

  assert.strictEqual(f.created.length, 1, 'closing the ticket reached an actual reviewer spawn');
  assert.strictEqual(f.one().loopStep, 'review', 'and the ticket advanced past verify');
});

test('a ticket with no worktree closes exactly as before — no loop, no loopStep', () => {
  const repo = mkRepo();
  const f = mkLoop({ repo, ticketOver: { worktree: null } });

  f.m._handleTask(f.seat('team-hand'), { type: 'task', sub: 'done', id: 't1', who: null, body: 'r' });

  const t = f.one();
  assert.strictEqual(t.state, 'done');
  assert.ok(!('loopStep' in t), 'done stays terminal for a shared-checkout ticket');
  assert.deepStrictEqual(f.esc(), [], 'and nothing escalates about it');
});

// ── §E: the watchdog hole ──────────────────────────────────────────────────

test('a done ticket the loop still holds is swept; a finished one is not', () => {
  const repo = mkRepo();
  const f = mkLoop({ repo });
  const old = Date.now() - (60 * 60 * 1000);
  f.tstore.save(f.team.root, [
    { ...f.one(), id: 'held', state: 'done', loopStep: 'review', lastActivityAt: old, nudgedAt: null },
    { ...f.one(), id: 'finished', state: 'done', lastActivityAt: old, nudgedAt: null },
  ]);

  f.m._sweepTeamTickets(f.team, Date.now());

  const nudges = f.gated.filter((g) => g.sender === 'ticket-watchdog');
  // ENTER: the interesting row survived the reduction. A sweep that produced no
  // nudges at all would satisfy "finished was not nudged" vacuously.
  assert.strictEqual(nudges.length, 1, 'exactly the in-flight ticket is nudged');
  assert.match(nudges[0].body, /\[ticket held\]/, 'and it is the held one, not the finished one');
});

test('an in-flight done ticket still gets ONE nudge per episode, not one per sweep', () => {
  const repo = mkRepo();
  const f = mkLoop({ repo });
  const old = Date.now() - (60 * 60 * 1000);
  f.tstore.save(f.team.root, [{ ...f.one(), id: 'held', state: 'done', loopStep: 'review', lastActivityAt: old, nudgedAt: null }]);

  f.m._sweepTeamTickets(f.team, Date.now());
  f.m._sweepTeamTickets(f.team, Date.now());
  f.m._sweepTeamTickets(f.team, Date.now());

  const nudges = f.gated.filter((g) => g.sender === 'ticket-watchdog');
  // The onWrite stamp guard has to accept this shape too. If it still tested
  // `state === 'open'` the stamp would be discarded and the ticket would nudge
  // on every single sweep — the episode rule inverted on exactly the tickets
  // the sweep was extended to cover.
  assert.strictEqual(nudges.length, 1, 'the stamp was recorded, so later sweeps stay quiet');
  assert.ok(f.tstore.load(f.team.root).find((t) => t.id === 'held').nudgedAt, 'nudgedAt is on disk');
});

// ── the verdict still lands ────────────────────────────────────────────────

test('a verdict lands on a done ticket the loop holds, and releases the hold', () => {
  const repo = mkRepo();
  const f = mkLoop({ repo });
  f.tstore.save(f.team.root, [{ ...f.one(), state: 'done', loopStep: 'review' }]);

  const landed = f.m._landVerdictOnTicket(f.seat('rev', repo.dir), 't1', '- **VERDICT**: ACCEPT\n- **MUST-FIX**: none');

  assert.ok(landed, 'the verdict must land — otherwise every loop verdict falls through to the lead');
  assert.strictEqual(landed.verdict, 'ACCEPT');
  const t = f.one();
  assert.strictEqual(t.verdict, 'ACCEPT');
  assert.ok(!('loopStep' in t), 'the verdict is the hand-off: the loop stops holding the ticket');
});

test('a verdict on a done ticket with NO loop hold still falls through to the lead', () => {
  const repo = mkRepo();
  const f = mkLoop({ repo });
  f.tstore.save(f.team.root, [{ ...f.one(), state: 'done' }]);

  const landed = f.m._landVerdictOnTicket(f.seat('rev', repo.dir), 't1', '- **VERDICT**: ACCEPT');

  // The exemption is scoped to a hold the loop actually has. An ad-hoc review of
  // a long-closed ticket must not revive its review fields.
  assert.strictEqual(landed, null, 'a finished ticket takes no verdict');
  assert.ok(!('verdict' in f.one()), 'and nothing was written to it');
});

// ── CHECK 4: the suite runs, and its result decides the arm ────────────────
//
// The defect this whole check exists for is a runner that reports green because
// it never ran — a wrong cwd, a swallowed dependency, an exit code read from the
// wrong process. That is invisible from a green board, so the subjects below are
// written to fail when the check DEGRADES, not only when it breaks: several
// assert that the reviewer was NOT spawned, which is also true if the loop dies
// early, and each therefore pins the reason as well as the outcome.

test('a red suite rejects to the hand and spawns NO reviewer', async () => {
  const repo = mkRepo();
  commitOnBranch(repo.dir, 'tl-1', 'work.txt', 'the work\n');
  const f = mkLoop({ repo, suite: 'red' });
  f.tstore.save(f.team.root, [{ ...f.one(), state: 'done', loopStep: 'verify', report: 'r', reportedBy: 'team-hand' }]);

  await f.m._runTicketLoop(f.team, 't1');
  await new Promise((r) => setImmediate(r));

  // The order claim, and the whole economic point of the ticket: a cold review
  // costs ~100k tokens, so a red branch must never reach one.
  assert.strictEqual(f.created.length, 0, 'no reviewer is spawned for a red branch');
  assert.deepStrictEqual(f.esc(), [], 'a red suite is rework, not an escalation to the lead');

  const sent = f.gated.filter((g) => /rejected/.test(g.body));
  assert.strictEqual(sent.length, 1, 'ENTER: exactly one rejection was delivered');
  assert.strictEqual(sent[0].target, 'team-hand', 'the rework goes to the hand, not the lead');
  // The failing NAMES, not just a count: "the suite failed" sends the hand back
  // to re-run it to find out what, which is the round trip this saves.
  assert.match(sent[0].body, /the thing that broke/, 'the failing test names ride the rejection');
  assert.match(sent[0].body, /the other thing/);
  assert.match(sent[0].body, /3\/5 passing, 2 failing/, 'and the counts do too');

  const t = f.one();
  assert.strictEqual(t.state, 'open', 'the ticket is reopened for rework');
  assert.ok(!('loopStep' in t), 'and the loop stops holding it');
  assert.strictEqual(t.closedAt, null, 'reopening clears the close stamp, exactly as _taskReject does');
});

test('a suite that exits 0 with failures counted is NOT green', async () => {
  // The escape shape. An error thrown on an async continuation that outlives its
  // test is counted PASS by the reporter while node's exit code stays honest —
  // and the reverse (exit 0, fail > 0) is what a miscounted run looks like.
  // Trusting either signal alone admits one of them, so green is the conjunction.
  const repo = mkRepo();
  commitOnBranch(repo.dir, 'tl-1', 'work.txt', 'the work\n');
  const f = mkLoop({ repo, suite: 'escaped' });
  f.tstore.save(f.team.root, [{ ...f.one(), state: 'done', loopStep: 'verify', report: 'r', reportedBy: 'team-hand' }]);

  await f.m._runTicketLoop(f.team, 't1');
  await new Promise((r) => setImmediate(r));

  assert.strictEqual(f.created.length, 0, 'a run reporting a failure reaches no reviewer, whatever it exited');
  const sent = f.gated.filter((g) => /rejected/.test(g.body));
  assert.strictEqual(sent.length, 1, 'ENTER: it was rejected as rework');
  assert.match(sent[0].body, /4\/5 passing, 1 failing/);
});

test('a suite that cannot run at all ESCALATES rather than rejecting', async () => {
  // A file that cannot even load is not the hand's rework: nothing was verified,
  // so "the suite fails, fix it" names no fix and no failing test. Rejecting here
  // opens a rework round nobody can close, so this must reach the lead instead.
  const repo = mkRepo();
  commitOnBranch(repo.dir, 'tl-1', 'work.txt', 'the work\n');
  const f = mkLoop({ repo, suite: 'crash' });
  f.tstore.save(f.team.root, [{ ...f.one(), state: 'done', loopStep: 'verify', report: 'r', reportedBy: 'team-hand' }]);

  await f.m._runTicketLoop(f.team, 't1');
  await new Promise((r) => setImmediate(r));

  assert.strictEqual(f.created.length, 0, 'no reviewer');
  const esc = f.esc();
  assert.strictEqual(esc.length, 1, 'ENTER: exactly one escalation reached the lead');
  assert.match(esc[0].body, /verify: suite/, 'the escalation names the step it stopped at');
  assert.match(esc[0].body, /no TOTALS summary/, 'and says the run never completed, not that tests failed');
  assert.strictEqual(esc[0].target, 'lead');
  assert.deepStrictEqual(f.gated.filter((g) => /rejected/.test(g.body)), [],
    'and the hand is NOT sent rework it cannot act on');
});

test('a runner that exits 0 printing NOTHING is not accepted as green', async () => {
  // THE FALSE GREEN THIS CHECK EXISTS TO PREVENT. A wrong cwd, a filter matching
  // nothing, a runner that died before it counted — all can exit 0 with no
  // summary. Exit code alone would call this a pass and spawn a reviewer for a
  // branch nothing verified, which is indistinguishable from a real green.
  const repo = mkRepo();
  commitOnBranch(repo.dir, 'tl-1', 'work.txt', 'the work\n');
  const f = mkLoop({ repo, suite: 'silent' });
  f.tstore.save(f.team.root, [{ ...f.one(), state: 'done', loopStep: 'verify', report: 'r', reportedBy: 'team-hand' }]);

  await f.m._runTicketLoop(f.team, 't1');
  await new Promise((r) => setImmediate(r));

  assert.strictEqual(f.created.length, 0, 'exit 0 without evidence of a run must not reach a reviewer');
  const esc = f.esc();
  assert.strictEqual(esc.length, 1, 'ENTER: it escalated');
  assert.match(esc[0].body, /no TOTALS summary/);
});

test('a branch with no test runner escalates, naming the missing runner', async () => {
  const repo = mkRepo();
  commitOnBranch(repo.dir, 'tl-1', 'work.txt', 'the work\n');
  const f = mkLoop({ repo, suite: 'none' });
  f.tstore.save(f.team.root, [{ ...f.one(), state: 'done', loopStep: 'verify', report: 'r', reportedBy: 'team-hand' }]);

  await f.m._runTicketLoop(f.team, 't1');
  await new Promise((r) => setImmediate(r));

  assert.strictEqual(f.created.length, 0, 'no reviewer');
  const esc = f.esc();
  assert.strictEqual(esc.length, 1, 'ENTER: it escalated');
  assert.match(esc[0].body, /no test runner at/, 'the evidence names what was missing');
});

test('the suite runs in the TICKET WORKTREE and holds the ROOT checkout lock', async () => {
  // Both halves are load-bearing and neither is visible from a green board.
  //
  // CWD: a runner invoked in the root checkout tests master and reports a real,
  // current, green number for code that was never run — a pass, not an error.
  //
  // LOCK: scripts/run-tests.js roots its lock at its OWN checkout, so a worktree
  // run would take the worktree's lock — a different mutex from the one the
  // lead's run holds. Both runs then reach the port-binding tests together and
  // deadlock at 0% CPU, which reads as a slow suite. A second lock is not
  // serialization, so the env override pinning it to the root is the fix.
  const repo = mkRepo();
  commitOnBranch(repo.dir, 'tl-1', 'work.txt', 'the work\n');
  const f = mkLoop({ repo, suite: 'green' });
  const wt = pathReal.join(repo.dir, 'wt');
  // The stub reports its own cwd and the lock env it was handed, so this asserts
  // what the CHILD actually received rather than what the caller meant to pass.
  fsReal.writeFileSync(pathReal.join(wt, 'scripts', 'run-tests.js'),
    'const fs = require("fs");\n'
    + 'fs.writeFileSync(process.env.T317_PROBE, JSON.stringify({\n'
    + '  cwd: process.cwd(),\n'
    + '  lock: process.env.CLODEX_TEST_LOCK_DIR || null,\n'
    + '  wait: process.env.CLODEX_TEST_LOCK_WAIT_MS || null,\n'
    + '  asNode: process.env.ELECTRON_RUN_AS_NODE || null,\n'
    + '}));\n'
    + 'console.log("TOTALS: 5 pass, 0 fail, 5 tests");\n');
  const probe = pathReal.join(repo.dir, 'probe.json');
  process.env.T317_PROBE = probe;
  f.tstore.save(f.team.root, [{ ...f.one(), state: 'done', loopStep: 'verify', report: 'r', reportedBy: 'team-hand' }]);

  await f.m._runTicketLoop(f.team, 't1');
  await new Promise((r) => setImmediate(r));
  delete process.env.T317_PROBE;

  assert.ok(fsReal.existsSync(probe), 'ENTER: the runner actually executed and wrote the probe');
  const got = JSON.parse(fsReal.readFileSync(probe, 'utf8'));
  assert.strictEqual(fsReal.realpathSync(got.cwd), fsReal.realpathSync(wt),
    'the suite runs in the ticket worktree, not the root checkout');
  // Compared against the resolved PARENT: the stub never takes the lock, so the
  // dir does not exist and realpath cannot resolve it — while the repo dir
  // itself is under a symlinked /var, so the raw strings differ.
  assert.strictEqual(pathReal.join(fsReal.realpathSync(pathReal.dirname(got.lock)), pathReal.basename(got.lock)),
    pathReal.join(fsReal.realpathSync(repo.dir), '.test-digest.lock'),
    'but takes the ROOT checkout lock, so it serializes against the lead run');
  assert.ok(Number(got.wait) > 0,
    'and WAITS for that lock: a ticket closing during another run must queue, never skip its own verification');
  // The loop spawns `process.execPath`, which under the desktop host is the
  // ELECTRON binary, not node (measured: .../Electron.app/Contents/MacOS/
  // Electron). Without this variable that spawn is an app launch: no tap is
  // written, no TOTALS is printed, and every ticket escalates forever with an
  // error naming the tap stream. It cannot be observed from a node-hosted test
  // run — under node the flag is inert — so what is pinned is that the loop
  // SETS it, which is the whole of the fix.
  assert.strictEqual(got.asNode, '1',
    'ELECTRON_RUN_AS_NODE must ride the spawn, or under the Electron host the runner is never node at all');
});

test('the worktree gets a node_modules link, or the whole suite is a false red', async () => {
  // A git worktree has no node_modules and nothing installs one. Measured in a
  // bare worktree: the 7 files requiring electron/node-pty/ws fail
  // MODULE_NOT_FOUND, so without this the loop would reject every ticket for a
  // defect in its own harness — a rework round the hand cannot possibly close.
  const repo = mkRepo();
  commitOnBranch(repo.dir, 'tl-1', 'work.txt', 'the work\n');
  const f = mkLoop({ repo, suite: 'green' });
  const link = pathReal.join(repo.dir, 'wt', 'node_modules');
  assert.ok(!fsReal.existsSync(link), 'ENTER: the worktree starts with no node_modules, like a real one');
  f.tstore.save(f.team.root, [{ ...f.one(), state: 'done', loopStep: 'verify', report: 'r', reportedBy: 'team-hand' }]);

  await f.m._runTicketLoop(f.team, 't1');
  await new Promise((r) => setImmediate(r));

  assert.ok(fsReal.existsSync(link), 'the loop linked node_modules into the worktree');
  assert.strictEqual(fsReal.realpathSync(link), fsReal.realpathSync(pathReal.join(repo.dir, 'node_modules')),
    'and it points at the root checkout tree');
  assert.strictEqual(f.created.length, 1, 'and the green run still reached its reviewer');
});

test('a test file that cannot even LOAD is rejected, named by its path', async () => {
  // MEASURED against the real runner, and it corrects an intuition worth
  // recording: an unparseable test file does NOT crash the run. Node reports it
  // as a single failing test named by its path and still prints a summary, so
  // this takes the reject arm — which is the right arm, because the hand can act
  // on "test/unloadable.test.js failed" and the branch is genuinely red.
  //
  // The property that must hold either way is that it is never GREEN and never
  // reaches a reviewer. That is what this pins.
  const repo = mkRepo();
  commitOnBranch(repo.dir, 'tl-1', 'work.txt', 'the work\n');
  const f = mkLoop({ repo, suite: 'unloadable' });
  f.tstore.save(f.team.root, [{ ...f.one(), state: 'done', loopStep: 'verify', report: 'r', reportedBy: 'team-hand' }]);

  await f.m._runTicketLoop(f.team, 't1');
  await new Promise((r) => setImmediate(r));

  assert.strictEqual(f.created.length, 0, 'a branch whose tests cannot load reaches no reviewer');
  const sent = f.gated.filter((g) => /rejected/.test(g.body));
  assert.strictEqual(sent.length, 1, 'ENTER: it was rejected as rework');
  assert.match(sent[0].body, /test\/unloadable\.test\.js/,
    'and names the file that would not load — the one thing the hand needs');
});

test('a run that executed ZERO tests escalates — it is not a green suite', async () => {
  // `TOTALS: 0 pass, 0 fail, 0 tests` and exit 0 satisfies both halves of the
  // green conjunction, so without the tests>0 clause a branch whose test files
  // were never discovered reaches a reviewer wearing a green hat. That is the
  // precise defect this whole ticket exists to prevent, arriving through the
  // counter door. ESCALATE, not reject: the hand cannot rework a run that found
  // nothing to run.
  const repo = mkRepo();
  commitOnBranch(repo.dir, 'tl-1', 'work.txt', 'the work\n');
  const f = mkLoop({ repo, suite: 'zerotests' });
  f.tstore.save(f.team.root, [{ ...f.one(), state: 'done', loopStep: 'verify', report: 'r', reportedBy: 'team-hand' }]);

  await f.m._runTicketLoop(f.team, 't1');
  await new Promise((r) => setImmediate(r));

  assert.strictEqual(f.created.length, 0, 'a run that verified nothing must not reach a reviewer');
  const esc = f.esc();
  assert.strictEqual(esc.length, 1, 'ENTER: exactly one escalation reached the lead');
  assert.match(esc[0].body, /ZERO tests/, 'and it says the run executed nothing, not that tests failed');
  assert.deepStrictEqual(f.gated.filter((g) => /rejected/.test(g.body)), [],
    'the hand is not sent rework for a run that discovered no tests');
});

test('the LAST TOTALS line decides, not the first a test file happened to print', async () => {
  // The runner prints its summary last. A test file forwarding a TOTALS-shaped
  // line of its own shadows it under a first-match read — and the shadowing line
  // can say anything, including green over a red run.
  const repo = mkRepo();
  commitOnBranch(repo.dir, 'tl-1', 'work.txt', 'the work\n');
  const f = mkLoop({ repo, suite: 'shadowed' });
  f.tstore.save(f.team.root, [{ ...f.one(), state: 'done', loopStep: 'verify', report: 'r', reportedBy: 'team-hand' }]);

  await f.m._runTicketLoop(f.team, 't1');
  await new Promise((r) => setImmediate(r));

  assert.strictEqual(f.created.length, 0, 'the shadowing green line must not carry a red branch to a reviewer');
  const sent = f.gated.filter((g) => /rejected/.test(g.body));
  assert.strictEqual(sent.length, 1, 'ENTER: it was rejected as rework');
  assert.match(sent[0].body, /1\/2 passing, 1 failing/,
    "the runner's own summary decides; 9/9 came from a line it merely forwarded");
});

test('a TOTALS decoy on STDERR does not beat the real summary on stdout', async () => {
  // The residual half of the shadowing fix. Reading the combined text puts ALL
  // of stderr after ALL of stdout no matter when either was written, so a
  // stderr line wins every last-match read — a green decoy carrying a red
  // branch to a reviewer. The runner prints its summary to stdout, so that is
  // the only stream the verdict may come from.
  const repo = mkRepo();
  commitOnBranch(repo.dir, 'tl-1', 'work.txt', 'the work\n');
  const f = mkLoop({ repo, suite: 'shadowedStderr' });
  f.tstore.save(f.team.root, [{ ...f.one(), state: 'done', loopStep: 'verify', report: 'r', reportedBy: 'team-hand' }]);

  await f.m._runTicketLoop(f.team, 't1');
  await new Promise((r) => setImmediate(r));

  assert.strictEqual(f.created.length, 0, 'the stderr decoy must not carry a red branch to a reviewer');
  const sent = f.gated.filter((g) => /rejected/.test(g.body));
  assert.strictEqual(sent.length, 1, 'ENTER: it was rejected as rework');
  assert.match(sent[0].body, /1\/2 passing, 1 failing/,
    "stdout's summary decides; the 9/9 on stderr is not the runner's verdict");
});

// Resolved OUTSIDE the subject so the absence can be a SKIP rather than a pass.
// A source checkout without devDependencies installed cannot answer this, and
// failing there would be a fixture complaint — but an early `return` inside the
// body reports PASS while asserting nothing, and one refactor later that is
// permanent invisible coverage loss.
let electronPath = null;
try { electronPath = require(pathReal.join(__dirname, '..', 'node_modules', 'electron')); } catch {}

test("this host's Electron really runs as node when the variable is set", {
  skip: electronPath ? false : 'node_modules/electron is not installed in this checkout',
}, () => {
  // The mechanism half of the ELECTRON_RUN_AS_NODE fix. The subject above can
  // only assert that the loop SETS the variable — under a node-hosted test run
  // the flag is inert, so no amount of pinning there shows it does anything.
  // This runs the actual binary the loop's process.execPath resolves to under
  // the desktop host and proves it comes up as a node interpreter rather than
  // an app. The idiom is scripts/electron-smoke.js's re-exec.
  //
  // What this still does NOT prove is that the SUITE is green under Electron's
  // node, which is a different (lower) version than the system node every green
  // in this repo was measured under. That needs a real Electron-hosted run.
  assert.ok(typeof electronPath === 'string' && fsReal.existsSync(electronPath),
    `ENTER: the electron module did not resolve to an existing binary (${electronPath})`);
  const r = require('node:child_process').spawnSync(
    electronPath, ['-p', 'process.versions.node'],
    { encoding: 'utf-8', timeout: 60000, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } },
  );
  assert.strictEqual(r.status, 0,
    `the Electron binary did not run as node (exit ${r.status}): ${(r.stderr || '').slice(0, 300)}`);
  assert.match(String(r.stdout || '').trim(), /^\d+\.\d+\.\d+/,
    'ELECTRON_RUN_AS_NODE must yield a node interpreter that can print its own version — without '
    + 'that the loop spawns an APP, no tap is written, and every ticket escalates on a missing '
    + 'tap stream');
});

// A hard cap, because the failure shape here is a HANG, not a red assertion:
// node:test's default per-test timeout is infinite (the lesson run-tests.js
// records), so without this a mutation that breaks the kill wedges the whole
// suite instead of failing this subject.
test('a runner that never exits is killed WITH ITS SWEEP, and ESCALATES', { timeout: 30000 }, async () => {
  // The arm that decides a ticket's fate when the machinery wedges, and the one
  // arm with no natural trigger — without the deps seam it could only be
  // exercised by waiting out the shipped cap, so it would ship unmeasured.
  // A kill must not look like rework: the branch was never judged.
  //
  // The GRANDCHILD is the point. The real runner blocks in spawnSync running
  // `node --test`, so killing the runner alone leaves that sweep alive and
  // reparented, still holding the real ports cli/test/attach.test.js binds —
  // and the next gate run reclaims the lock the killed runner never released
  // and deadlocks against it at 0% CPU. The stub reproduces the shape: a child
  // that outlives its parent and keeps writing a marker while it lives.
  const repo = mkRepo();
  commitOnBranch(repo.dir, 'tl-1', 'work.txt', 'the work\n');
  // 3000ms, not the 300 this shipped with for one round. The marker cannot
  // exist before stub-node boot + spawn + grandchild-node boot, ~115ms idle —
  // but this subject's only real habitat is a full sweep, where node --test
  // runs files at CPU-count concurrency and two cold node boots at 150-250ms
  // each blow straight past 300. The kill would then reap the grandchild
  // before its first write and the ENTER below would fail for a ticket that
  // changed nothing: a gate that rejects everything, which is the mirror image
  // of the defect this whole check exists to remove. Widening does not weaken
  // the falsifier — a survivor still moves its mtime across the settle, and
  // the 30s subject cap still bounds a regressed kill.
  const f = mkLoop({ repo, suite: 'hang', suiteTimeoutMs: 3000 });
  const kid = pathReal.join(repo.dir, 'kid.marker');
  process.env.T317_KID = kid;
  try {
    f.tstore.save(f.team.root, [{ ...f.one(), state: 'done', loopStep: 'verify', report: 'r', reportedBy: 'team-hand' }]);

    await f.m._runTicketLoop(f.team, 't1');
    await new Promise((r) => setImmediate(r));

    assert.strictEqual(f.created.length, 0, 'a wedged run reaches no reviewer');
    const esc = f.esc();
    assert.strictEqual(esc.length, 1, 'ENTER: exactly one escalation reached the lead');
    assert.match(esc[0].body, /did not finish within 3000ms \(killed\)/,
      'the escalation says it was killed, and after how long');
    assert.deepStrictEqual(f.gated.filter((g) => /rejected/.test(g.body)), [],
      'and the hand is not sent rework for a run that was killed — its TOTALS line proves nothing');

    // ENTER: the grandchild must have existed, or "it is gone now" is vacuously
    // true and this subject measures nothing at all.
    assert.ok(fsReal.existsSync(kid),
      'ENTER: the stub spawned a grandchild that wrote its marker before the kill');
    // It writes every 50ms while alive. A survivor moves this mtime; a reaped one
    // cannot. Measured after a settle longer than its own interval.
    const at = fsReal.statSync(kid).mtimeMs;
    await new Promise((r) => setTimeout(r, 600));
    assert.strictEqual(fsReal.statSync(kid).mtimeMs, at,
      'the grandchild is still writing — the kill signalled only the runner and orphaned the sweep, '
      + 'which then holds the port-binding tests against every later gate run');
  } finally {
    // In a finally, or a failed ENTER leaks the variable into every later
    // subject in this file — where a stale path would let a stub write a
    // marker some other assertion then reads as its own.
    delete process.env.T317_KID;
  }
});

test('an accept landing DURING the suite run cannot be resurrected into review', async () => {
  // The window this closes is minutes wide. The entry guard reads loopStep, then
  // the loop awaits a whole suite; a lead `task accept` inside that await
  // retires the seat, removes the worktree and deletes the branch. Re-writing
  // the hold afterwards makes the ticket in-flight again and lets a late verdict
  // stamp REWORK onto merged, deleted work.
  const repo = mkRepo();
  commitOnBranch(repo.dir, 'tl-1', 'work.txt', 'the work\n');
  const f = mkLoop({ repo, suite: 'green' });
  const wt = pathReal.join(repo.dir, 'wt');
  // The mutation happens while the runner is IN FLIGHT — the stub blocks until
  // the test sees its marker file and then clears the hold, so the accept lands
  // strictly inside the await rather than before or after it.
  const marker = pathReal.join(repo.dir, 'running.marker');
  const go = pathReal.join(repo.dir, 'go.marker');
  fsReal.writeFileSync(pathReal.join(wt, 'scripts', 'run-tests.js'),
    'const fs = require("fs");\n'
    + `fs.writeFileSync(${JSON.stringify(marker)}, "1");\n`
    + `while (!fs.existsSync(${JSON.stringify(go)})) {\n`
    + '  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);\n'
    + '}\n'
    + 'console.log("TOTALS: 5 pass, 0 fail, 5 tests");\n');
  f.tstore.save(f.team.root, [{ ...f.one(), state: 'done', loopStep: 'verify', report: 'r', reportedBy: 'team-hand' }]);

  const loop = f.m._runTicketLoop(f.team, 't1');
  // Wait for the child to actually be running before mutating.
  for (let i = 0; i < 400 && !fsReal.existsSync(marker); i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.ok(fsReal.existsSync(marker),
    'ENTER: the suite child is running, so the mutation below lands INSIDE the await');
  const t = f.one();
  delete t.loopStep;
  t.state = 'accepted';
  f.tstore.save(f.team.root, [t]);
  fsReal.writeFileSync(go, '1');
  await loop;
  await new Promise((r) => setImmediate(r));

  assert.strictEqual(f.created.length, 0, 'no reviewer is spawned for a ticket the loop no longer holds');
  assert.ok(!('loopStep' in f.one()),
    'and the hold is NOT re-written onto it — that is what makes a late verdict landable');
  assert.strictEqual(f.one().state, 'accepted', 'the accept stands, untouched by the returning loop');
  assert.deepStrictEqual(f.esc(), [], 'and this is a normal race, not something to wake the lead over');
});

test('the kill cap is strictly GREATER than the lock wait, or the wait is dead code', () => {
  // Read off the shipped module text, not the fixture: the two constants must
  // stay related and the relation is invisible at every call site. The kill timer
  // starts at SPAWN, so it covers the lock wait — shipping the cap BELOW the wait
  // makes the wait unreachable and reports a ticket that was politely queuing as
  // `did not finish within 900000ms (killed)`, a wedge report for a healthy run.
  // test/test-digest-lock.test.js pins the same relation for the other entry
  // point, where the inversion cost three misdiagnosed timeouts.
  const src = fsReal.readFileSync(pathReal.join(__dirname, '..', 'session-manager.js'), 'utf8');
  const wait = /const TICKET_SUITE_LOCK_WAIT_MS = ([^;]+);/.exec(src);
  const timeout = /const TICKET_SUITE_TIMEOUT_MS = ([^;]+);/.exec(src);
  // ENTER: renamed or reshaped constants must fail HERE rather than skip the
  // comparison and leave this subject asserting nothing.
  assert.ok(wait, 'TICKET_SUITE_LOCK_WAIT_MS is still declared with a literal expression');
  assert.ok(timeout, 'TICKET_SUITE_TIMEOUT_MS is still declared with a literal expression');
  // eslint-disable-next-line no-new-func
  const waitMs = Function(`"use strict";const TICKET_SUITE_LOCK_WAIT_MS=${wait[1]};return TICKET_SUITE_LOCK_WAIT_MS;`)();
  // eslint-disable-next-line no-new-func
  const timeoutMs = Function(`"use strict";const TICKET_SUITE_LOCK_WAIT_MS=${wait[1]};return ${timeout[1]};`)();
  assert.ok(Number.isFinite(waitMs) && waitMs > 0, `ENTER: the wait did not evaluate to a duration (${waitMs})`);
  assert.ok(Number.isFinite(timeoutMs) && timeoutMs > 0, `ENTER: the cap did not evaluate to a duration (${timeoutMs})`);
  assert.ok(waitMs < timeoutMs,
    `the loop waits up to ${waitMs}ms for the lock but kills the child at ${timeoutMs}ms — equal or `
    + 'less means a queued run is reported as a wedge and the wait constant can never be reached');
});
