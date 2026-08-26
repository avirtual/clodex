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
const { mkTmpRoot } = require('./lib/tmp-roots');
// The REAL parser, used to execute the recovery an escalation prescribes rather
// than to pattern-match it: a copy of the grammar in this file would agree with
// itself after a rename and let the advice go stale silently.
const { parseWithRegistry } = require('../intent-registry');
// The REAL parser for the t384 subjects below, for the same reason: these
// fixtures feed `ps` output verbatim off a live observation, and a hand-computed
// millisecond value here would agree with a wrong parser forever.
const { parseCpuTime } = require('../stall-evidence');

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
  // A red run carrying the DIAGNOSTICS, not just the names: the dot reporter
  // prints the AssertionError, the `+ actual - expected` diff and the stack
  // under each `✖` row, and that block is the whole evidence the preserved file
  // exists to keep. `red` above stops at the names, so it cannot tell a file
  // that saved the diagnostics from one that saved only what the rejection
  // message already carries.
  //
  // Copied off a real `node scripts/run-tests.js --reporter=dot` run against a
  // deliberately failing deepStrictEqual, under the same rule as every stub
  // here — the indentation, the `+ actual - expected` header and the bare-brace
  // diff shape are node's, not invented.
  redWithDiff: 'console.log("X.");\nconsole.log("");\nconsole.log("Failed tests:");\nconsole.log("");\n'
    + 'console.log("\\u2716 probe alpha fails with a deep diff (2.083792ms)");\n'
    + 'console.log("  AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:");\n'
    + 'console.log("  + actual - expected");\n'
    + 'console.log("    {");\n'
    + 'console.log("  +   a: 1,");\n'
    + 'console.log("  -   a: 2,");\n'
    + 'console.log("    }");\n'
    + 'console.log("      at TestContext.<anonymous> (/tmp/probe/frag.test.js:4:10)");\n'
    + 'console.log("TOTALS: 1 pass, 1 fail, 2 tests");\nprocess.exit(1);\n',
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
  const dir = mkTmpRoot('clodex-loop-repo-');
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
  // t421: the team has NO `reviewer` ROLE at all — the state an operator reaches
  // by removing it. Distinct from noReviewerPrompt, which is a role whose prompt
  // file is missing: that one SPAWNS a seat and escalates as UNBRIEFED, this one
  // never reaches a spawn.
  noReviewerRole = false,
  suiteTimeoutMs = null,
  // Wraps the REAL git-worktree rather than replacing it, so a caller can count
  // which git operations the loop reached without giving up the real ones the
  // header argues for. Identity by default: an unwrapped fixture is unchanged.
  wrapGit = (gw) => gw,
  // Same shape, same reason, for `fs`. One subject needs a writeFileSync that
  // leaves BYTES ON DISK and then throws — the ENOSPC/killed-mid-write shape —
  // which no real filesystem can be talked into from here on demand.
  wrapFs = (f) => f,
} = {}) {
  stubSuite(repo, suite);
  const home = mkTmpRoot('clodex-loop-');
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
      ...(noReviewerRole ? {} : {
        reviewer: {
          instantiate: 'subagent', prompt: 'clodex-team-reviewer', brief: 'the reviewer',
          tools: ['Read', 'Grep', 'Glob'], type: null, template: null, standing: null, ephemeral: false,
        },
      }),
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
    fs: wrapFs(fsReal),
    path: pathReal,
    // The REAL path grammar, not a stub. It was missing entirely until t384
    // needed it, and the gap was SILENT in the way CLAUDE.md's fixture rule
    // names: an un-injected dep arrives as `undefined`, every `pathFor(...)`
    // call throws, and `_seatTranscriptSize`'s catch turns that into "no
    // transcript" — a fixture in which no seat can ever be measured, asserting
    // nothing while passing.
    pathFor: require('../clodex-paths').pathFor,
    runDirFor: require('../clodex-paths').runDirFor,
    os: osReal,
    ensureDir: require('../fs-util').ensureDir,
    // The REAL module, deliberately: see the header. A stub here would assert
    // only that the loop calls the functions it calls.
    gitWorktree: wrapGit(require('../git-worktree')),
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
  // onWrite is INVOKED, not dropped: the watchdog's nudge stamp rides it (the
  // real queue calls it when the delivery is written), so a stub that ignores it
  // models a system where no stall episode is ever stamped — under which the
  // one-nudge-per-episode assertions below would fail for a reason that exists
  // only in the fixture.
  // `tag` is recorded ALONGSIDE the body, not merged into the pushed row: the
  // deepStrictEqual pins below assert `gated` entries whole, and widening that
  // shape would rewrite pins that are not about the tag.
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
    m, team, home, tstore, persistence, injected, gated, tags, broadcasts, created, seat, logs,
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

// SIBLING PIN: `--no-ext-diff`, the other mandatory flag in this leaf's argv, is
// pinned in test/ticket-auto-merge.test.js ("the diff leaf DEFEATS an external
// diff driver"). Someone editing that argv greps one flag and lands on one of the
// two subjects; each names the other so neither is edited alone.
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

// Nine measured firings, each one computing a diff (78625 bytes at the worst)
// against a destination that was already unresolvable when the step began. The
// check moved AHEAD of the diff, so the wasted git pass is not merely reported
// — it never runs.
test('an unresolvable task dir escalates BEFORE the diff is computed, not after', async () => {
  const repo = mkRepo();
  commitOnBranch(repo.dir, 'tl-1', 'work.txt', 'the work\n');
  let diffCalls = 0;
  const f = mkLoop({
    repo,
    // The ~86% case: a spec naming no artifact dir anywhere, so no taskDir.
    ticketOver: { spec: 'a title with no artifact path\n\nbody prose', taskDir: undefined },
    wrapGit: (gw) => ({ ...gw, diffText: (...a) => { diffCalls += 1; return gw.diffText(...a); } }),
  });
  f.tstore.save(f.team.root, [{ ...f.one(), state: 'done', loopStep: 'verify', report: 'r', reportedBy: 'team-hand' }]);
  assert.strictEqual(f.one().taskDir, undefined, 'ENTER: the ticket really carries no task dir');

  await f.m._runTicketLoop(f.team, 't1');
  await new Promise((r) => setImmediate(r));

  const esc = f.esc();
  assert.strictEqual(esc.length, 1, 'exactly one escalation');
  // THE assertion of this test. A pass-through wrapper is the only way to see
  // it: the escalation body reads almost the same either way, and every other
  // observable (no reviewer, no diff file, one escalation) was ALREADY true
  // when the loop computed 78kB and threw it away.
  assert.strictEqual(diffCalls, 0, 'no diff is computed for a ticket with nowhere to put one');
  assert.strictEqual(f.diffFile().length, 0, 'and nothing is written');
  assert.strictEqual(f.created.length, 0, 'no reviewer is spawned');
  assert.match(esc[0].body, /verify: task-dir/, 'the escalation names its own check, not the diff check');
  // The CAUSE and the FIX, not just the symptom: every one of the nine firings
  // read as a loop bug because the message named only "no resolvable task dir".
  assert.match(esc[0].body, /names no `tasks\/…` path/, 'the evidence names the cause');
  // The recovery must be one that EXISTS. Asserted as a real verb plus the two
  // absences, because the first draft of this message prescribed `task edit`
  // (no such verb in parseTask) and "re-run task done" (refused — the ticket is
  // already done), and this pin locked that dead end in instead of catching it.
  // NOT `reject`. This pin asserted it until t406, and it contradicted the MF2
  // subject below — which asserts this same arm must say "Re-closing alone will
  // NOT help … Correct the spec", i.e. do NOT reject. Two subjects in one file
  // prescribing opposite routes, green only because the evidence string still
  // carried a stale `reject` the arm had already stopped recommending. What the
  // message must name is a verb that EXISTS and terminates; which verb is the
  // arm's call, and it is pinned there.
  assert.match(esc[0].body, /\[agent:task done t1\]/, 'the recovery names the verb the spec arm actually prescribes');
  assert.doesNotMatch(esc[0].body, /task edit/, 'there is no `edit` verb in the task grammar');
  assert.doesNotMatch(esc[0].body, /re-run `?task done/, 'and `done` is refused on an already-done ticket');
  // The advice is EXECUTED, not pattern-matched. Two earlier versions of this
  // pin failed the same way at different depths: the first asserted a literal
  // (`task edit`) the parser refuses, the second compared the verb against a
  // hand-copied list of the grammar — which is not a binding to it, so renaming
  // the verb in parseTask left both the copy and the assertion agreeing while
  // the escalation prescribed something the parser would reject. The only thing
  // that cannot drift is running the real parser over the real message.
  const lit = /\[agent:task[^\]]*\]/.exec(esc[0].body);
  assert.ok(lit, 'ENTER: the message must suggest a task intent at all');
  const parsed = parseWithRegistry(`${lit[0]} the spec names no artifact dir`);
  assert.ok(parsed && parsed.type === 'task', 'the suggested intent must actually parse');
  assert.strictEqual(parsed.sub, 'done', 'and it is the verb the spec arm prescribes — re-close, after editing the spec in place');
  assert.strictEqual(parsed.id, 't1', 'carrying the ticket the escalation is about');
  assert.ok(intentEnabled('task'), 'ENTER: the task intent is enabled, so the advice is executable');

  // END-TO-END: the parsed intent is DRIVEN, so this pins that the recovery
  // WORKS rather than that the string looks right. The ticket is still `done`
  // here — _escalateTicket clears loopStep only — and the arm's route is to
  // correct the spec IN PLACE (editable in any state) and then re-close, which
  // re-runs the checks from where they stopped. That coupling between the
  // advised verb and the state the ticket is actually in is invisible to any
  // string check, and it is the whole reason this block drives the intent.
  assert.strictEqual(f.one().state, 'done', 'ENTER: escalation leaves the ticket done and held');
  const held = f.one().verifyHold;
  assert.ok(held && held.recovery === 'spec', 'ENTER: held under the SPEC class, which is the arm rendered above');
  // The spec is corrected first — the step the arm names and the only one that
  // changes the input the failing check re-reads. Without it the re-close is the
  // non-terminating loop the arm exists to warn against.
  f.tstore.save(f.team.root, [{ ...f.one(), spec: 'tasks/fixed — a title\n\nbody', taskDir: 'tasks/fixed' }]);
  f.m._handleTask(f.m.sessions.get('lead'), { ...parsed, body: 'the spec now names its artifact dir' });
  assert.strictEqual(f.one().taskDir, 'tasks/fixed', 'the corrected spec is what the re-close reads');
});

// The OTHER arm of the same check, and a regression the hoist introduced: a
// taskDir that escapes confinement makes resolveTaskDir THROW. Before the hoist
// that case escalated through _writeTicketDiff carrying the real reason; a
// pre-check reading only `.ok` reports the spec-formatting sentence instead,
// which is false for this arm, and drops the confinement error entirely.
test('a REFUSED task dir escalates with the confinement error, not the missing-path advice', async () => {
  const repo = mkRepo();
  commitOnBranch(repo.dir, 'tl-1', 'work.txt', 'the work\n');
  let diffCalls = 0;
  const f = mkLoop({
    repo,
    // Reachable, not theoretical: extractTaskDir's charset admits `.` and `/`.
    ticketOver: { taskDir: 'tasks/../../../../etc' },
    wrapGit: (gw) => ({ ...gw, diffText: (...a) => { diffCalls += 1; return gw.diffText(...a); } }),
  });
  f.tstore.save(f.team.root, [{ ...f.one(), state: 'done', loopStep: 'verify', report: 'r', reportedBy: 'team-hand' }]);
  assert.strictEqual(f.one().taskDir, 'tasks/../../../../etc', 'ENTER: the ticket carries an escaping path');

  await f.m._runTicketLoop(f.team, 't1');
  await new Promise((r) => setImmediate(r));

  const esc = f.esc();
  assert.strictEqual(esc.length, 1, 'exactly one escalation');
  assert.strictEqual(diffCalls, 0, 'this arm is caught before the diff too');
  assert.strictEqual(f.created.length, 0, 'no reviewer is spawned');
  assert.match(esc[0].body, /refused/, 'the confinement error rides the evidence');
  assert.match(esc[0].body, /tasks\/\.\.\/\.\.\/\.\.\/\.\.\/etc/, 'and names the offending path');
  // THE regression assertion: the missing-path story is false here, because the
  // spec named a path — it was refused, not absent.
  assert.doesNotMatch(esc[0].body, /names no `tasks\/…` path/,
    'a refused path must not be reported as an absent one');
  assert.doesNotMatch(esc[0].body, /task reject/,
    'and re-filing the spec is not the recovery for a path that escapes confinement');
});

// The other half of the same fix: with the path on line 3 the loop now runs
// clean. Without the extractTaskDir widening this is the ticket shape that
// escalated ~86% of the time.
test('a spec naming its task dir on a LATER line reaches the reviewer', async () => {
  const repo = mkRepo();
  commitOnBranch(repo.dir, 'tl-1', 'work.txt', 'the work\n');
  const spec = 't1 — the title\n\ntasks/loop-fixture — the artifact dir\n';
  const f = mkLoop({ repo, ticketOver: { spec, taskDir: ticketsMod.extractTaskDir(spec) } });
  assert.strictEqual(f.one().taskDir, 'tasks/loop-fixture',
    'ENTER: extractTaskDir must have found the line-3 path, or this measures the line-1 case');
  f.tstore.save(f.team.root, [{ ...f.one(), state: 'done', loopStep: 'verify', report: 'r', reportedBy: 'team-hand' }]);

  await f.m._runTicketLoop(f.team, 't1');
  await new Promise((r) => setImmediate(r));

  assert.deepStrictEqual(f.esc(), [], 'nothing escalates');
  assert.strictEqual(f.created.length, 1, 'the reviewer is spawned');
  assert.strictEqual(f.diffFile().length, 1, 'and its diff was written');
});

test('escalation tears nothing down, and HOLDS the ticket for the recovery', async () => {
  // t345 overturned the second half of this subject. It used to assert the hold
  // was RELEASED — `!('loopStep' in t)` — which is precisely the stranding: the
  // ticket fell out of flight, the sweep stopped seeing it, and `task done`
  // bounced. The tear-nothing-down half is unchanged and still the point.
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
  assert.strictEqual(t.loopStep, 'verify', 'the hold stays: a human owes this ticket an action');
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
  await f.m._sweepTeamTickets(f.team, Date.now());

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

test('a PARKED escalation counts as REACHED, and is stamped like any other', async () => {
  // The delivery classification this subject exists for is unchanged: a park is a
  // written file the seat drains, so it counts as reached where a bare `held`
  // does not. What changed with t345 is what "reached" DOES on a verify arm — it
  // no longer releases the hold, so the observable is the stamp rather than the
  // absence of `loopStep`. Asserting the release here would re-pin the stranding.
  const repo = mkRepo();
  const f = mkLoop({ repo });
  f.m._gatedDeliver = (target, sender, body) => { f.gated.push({ target, sender, body }); return { parked: 'park-1' }; };
  f.tstore.save(f.team.root, [{ ...f.one(), state: 'done', loopStep: 'verify', report: 'r', reportedBy: 'team-hand' }]);

  await f.m._runTicketLoop(f.team, 't1');

  const t = f.one();
  assert.strictEqual(t.loopStep, 'verify', 'the hold stays — the recovery runs from here');
  assert.ok(t.verifyHold, 'and the board carries the escalation the park will deliver');
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
  await f.m._sweepTeamTickets(f.team, Date.now());
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

// ── a team with NO reviewer role (t421) ────────────────────────────────────
//
// t421 lets an operator REMOVE the `reviewer` role, and this is the property
// that makes a reviewer-less team coherent rather than broken: the loop must
// escalate to the lead at the review step, not hang holding the ticket. The code
// path already existed (the spawn handler replies `error: … has no "reviewer"
// role to spawn`, and onReply turns an `error:` reply into an escalation) — but
// nothing asserted it, so nothing stopped a future edit from turning that reply
// into a throw, a silence, or a log line. Removal is only safe to OFFER while
// these hold.

test('a team with NO reviewer role escalates at the review step instead of hanging', async () => {
  const repo = mkRepo();
  commitOnBranch(repo.dir, 'tl-1', 'work.txt', 'the work\n');
  const f = mkLoop({ repo, noReviewerRole: true });
  assert.ok(!f.team.roles.reviewer,
    'ENTER: the fixture team genuinely has no reviewer role — with one present this measures the ordinary green path and asserts nothing about absence');
  f.tstore.save(f.team.root, [{ ...f.one(), state: 'done', loopStep: 'verify', report: 'I did the work. Suite green at 4999.', reportedBy: 'team-hand' }]);

  await f.m._runTicketLoop(f.team, 't1');
  // Same setImmediate drain as the green path, and for the same reason: the
  // spawn refusal is raised inside _handleTeamReview's setImmediate, so an early
  // assertion would see zero escalations and pass by being early.
  await new Promise((r) => setImmediate(r));

  const esc = f.esc();
  assert.strictEqual(esc.length, 1, 'exactly one escalation reaches the lead');
  assert.strictEqual(esc[0].target, 'lead', 'and it goes to the lead, who is now the reviewer');
  assert.match(esc[0].body, /stopped at: review: spawn/, 'the escalation names the review step');
  assert.match(esc[0].body, /has no "reviewer" role to spawn/,
    'and carries the actual reason, so the lead is not left guessing why no review happened');
  assert.strictEqual(f.created.length, 0, 'no seat is spawned');
  assert.strictEqual(f.persistence.list().filter((e) => e.reviewTicket).length, 0,
    'and none is reserved — nothing is left holding a review that cannot happen');
});

test('the reviewer-less escalation RELEASES the hold — no seat can ever answer it', async () => {
  // The counterpart of the UNBRIEFED arm below, which keeps the hold BECAUSE a
  // seat spawned and may still emit a verdict. Here nothing spawned, so holding
  // the ticket in-flight would leave the stall watchdog nudging the lead forever
  // about a review that is never coming. This is the assertion that distinguishes
  // "escalates" from "escalates AND stops".
  const repo = mkRepo();
  commitOnBranch(repo.dir, 'tl-1', 'work.txt', 'the work\n');
  const f = mkLoop({ repo, noReviewerRole: true });
  f.tstore.save(f.team.root, [{ ...f.one(), state: 'done', loopStep: 'verify', report: 'r', reportedBy: 'team-hand' }]);

  await f.m._runTicketLoop(f.team, 't1');
  await new Promise((r) => setImmediate(r));

  assert.strictEqual(f.esc().length, 1, 'ENTER: the reviewer-less arm escalated');
  const t = f.one();
  // The key is DELETED, not nulled (_setLoopStep's `else delete`), so match on
  // absence rather than on null — an assertion against null here would fail on
  // correct behaviour.
  assert.ok(!('loopStep' in t), 'the hold is released');
  assert.strictEqual(ticketInFlight(t), false, 'the ticket is no longer in flight');
  assert.strictEqual(t.state, 'done', 'and it stays done — the work is not reopened by the missing reviewer');
});

test('a STANDING ticket on a reviewer-less team never reaches the review step at all', async () => {
  // The loop is gated on `ticket.worktree.branch`, so a standing-dispatch ticket
  // terminates at `done` and never asks for a reviewer. Removing the role must
  // not change that — a standing team that suddenly started escalating every
  // closed ticket to its lead would be the loud failure of this ticket.
  const repo = mkRepo();
  const f = mkLoop({ repo, noReviewerRole: true, ticketOver: { worktree: null } });
  assert.strictEqual(f.one().worktree, null, 'ENTER: the ticket really is standing-dispatch, with no worktree block');

  // Driven through `done`, NOT by calling _runTicketLoop directly: the loop
  // returns at its first line for any ticket whose loopStep is not `verify`, so
  // a direct call would satisfy every assertion below without ever consulting
  // `loopEligible` — the gate this test exists to pin. The stamp happens inside
  // _taskDone, so that is the door the test has to come through.
  f.m._handleTask(f.seat('team-hand'), { type: 'task', sub: 'done', id: 't1', who: null, body: 'r' });
  await new Promise((r) => setImmediate(r));

  const t = f.one();
  assert.strictEqual(t.state, 'done', 'ENTER: the close actually landed — every assertion below is true of a ticket nothing closed');
  assert.deepStrictEqual(f.esc(), [], 'nothing escalates — done is simply terminal here');
  assert.strictEqual(f.created.length, 0, 'and no reviewer is sought');
  assert.ok(!('loopStep' in t), 'the ticket was never stamped into the loop');
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

test('a verify escalation with no live seat behind it is HELD, not finished', async () => {
  // OVERTURNED BY t345, and this subject's original reasoning is the defect
  // stated as an intention: "nothing can ever land a verdict on that ticket, so
  // holding it would leave the sweep nudging about a loop that has stopped."
  // The premise was right and the conclusion inverted — a verify failure is
  // something a HUMAN can fix, so the ticket is not finished; it is waiting. The
  // sweep nudging about it is the desired behaviour, not the cost.
  //
  // The reviewer-less arm above still releases, and that distinction survives:
  // there, nobody can ever act. Here the hand commits and closes again.
  const repo = mkRepo();
  const f = mkLoop({ repo });   // no commit on the branch: CHECK 1 fails
  f.tstore.save(f.team.root, [{ ...f.one(), state: 'done', loopStep: 'verify', report: 'r', reportedBy: 'team-hand' }]);

  await f.m._runTicketLoop(f.team, 't1');
  await new Promise((r) => setImmediate(r));

  assert.strictEqual(f.esc().length, 1, 'ENTER: the verify arm escalated');
  const t = f.one();
  assert.strictEqual(t.loopStep, 'verify', 'a delivered verify escalation keeps the hold');
  assert.strictEqual(ticketInFlight(t), true, 'the ticket is waiting on a human, which is in flight');
});

test('the nudge for a loop-held ticket names the STEP, not the finished hand', async () => {
  const repo = mkRepo();
  const f = mkLoop({ repo });
  const old = Date.now() - (60 * 60 * 1000);
  f.tstore.save(f.team.root, [{ ...f.one(), state: 'done', loopStep: 'review', lastActivityAt: old, nudgedAt: null }]);

  await f.m._sweepTeamTickets(f.team, Date.now());

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

test('a done ticket the loop still holds is swept; a finished one is not', async () => {
  const repo = mkRepo();
  const f = mkLoop({ repo });
  const old = Date.now() - (60 * 60 * 1000);
  f.tstore.save(f.team.root, [
    { ...f.one(), id: 'held', state: 'done', loopStep: 'review', lastActivityAt: old, nudgedAt: null },
    { ...f.one(), id: 'finished', state: 'done', lastActivityAt: old, nudgedAt: null },
  ]);

  await f.m._sweepTeamTickets(f.team, Date.now());

  const nudges = f.gated.filter((g) => g.sender === 'ticket-watchdog');
  // ENTER: the interesting row survived the reduction. A sweep that produced no
  // nudges at all would satisfy "finished was not nudged" vacuously.
  assert.strictEqual(nudges.length, 1, 'exactly the in-flight ticket is nudged');
  assert.match(nudges[0].body, /\[ticket held\]/, 'and it is the held one, not the finished one');
});

test('an in-flight done ticket still gets ONE nudge per episode, not one per sweep', async () => {
  const repo = mkRepo();
  const f = mkLoop({ repo });
  const old = Date.now() - (60 * 60 * 1000);
  f.tstore.save(f.team.root, [{ ...f.one(), id: 'held', state: 'done', loopStep: 'review', lastActivityAt: old, nudgedAt: null }]);

  await f.m._sweepTeamTickets(f.team, Date.now());
  await f.m._sweepTeamTickets(f.team, Date.now());
  await f.m._sweepTeamTickets(f.team, Date.now());

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
  // t353 r2: rework is a SECOND close, and the verb has to ride it for the same
  // reason it rides a first dispatch — otherwise that close falls back on the
  // seeded role prompt, which is a file that demonstrably drifts.
  assert.match(sent[0].body, /CLOSE WITH: \[agent:task done /,
    'the rework carries the close verb — a second close must not depend on the seeded prompt');
  // t353 r3: and on the POINTER, which is a separate argument the body cannot
  // vouch for. Appending the close line pushed this body past the spill threshold,
  // so the tag became the only text the seat reads before opening the file.
  // Indexed off the rejection's own row rather than asserting the array whole:
  // the loop delivers on other paths too, and a length pin here would go red on
  // unrelated traffic.
  assert.ok(sent[0].body.length > 500,
    `ENTER: the rejection must actually spill (body was ${sent[0].body.length} bytes), or the tag is cosmetic`);
  const rejIdx = f.gated.findIndex((g) => /rejected/.test(g.body));
  assert.strictEqual(f.tags[rejIdx], '[ticket t1 rejected] close with [agent:task done t1]',
    'the loop`s rework pointer names the ticket and the verb');

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
// Only a missing install may be swallowed: a corrupted or half-installed
// electron would otherwise skip under a reason that is not true.
try { electronPath = require(pathReal.join(__dirname, '..', 'node_modules', 'electron')); } catch (e) { if (e.code !== 'MODULE_NOT_FOUND') throw e; }

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
  // team-tickets.js since t380 — both constants moved there with the suite
  // runner that reads them.
  const src = fsReal.readFileSync(pathReal.join(__dirname, '..', 'team-tickets.js'), 'utf8');
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

// ── the harness cannot verify this branch: escalate, never reject ──────────
//
// Both subjects below are the same defect class as the TOTALS check above, one
// step earlier: the suite runs against a dependency tree the BRANCH does not
// describe, so its answer — red or green — is about the wrong dependency set.
// Neither is the hand's rework, so both take the escalate arm.

// Writes the two package.json files the deps comparison reads. Returns nothing;
// the fixture's worktree is repo.dir/wt, which stubSuite has already made.
function plantPkgs(repo, rootDeps, branchDeps) {
  fsReal.writeFileSync(pathReal.join(repo.dir, 'package.json'),
    JSON.stringify({ name: 'root', dependencies: rootDeps }, null, 2));
  fsReal.writeFileSync(pathReal.join(repo.dir, 'wt', 'package.json'),
    JSON.stringify({ name: 'root', dependencies: branchDeps }, null, 2));
}

test('a branch that ADDS a dependency escalates instead of taking a false RED', async () => {
  // MEASURED FAILURE MODE: the loop links the ROOT's node_modules into the
  // worktree, so a dep the branch added is not installed, the file requiring it
  // dies MODULE_NOT_FOUND, and the suite goes red. The reject arm then sends the
  // hand rework for correct code — the fix is `npm install` in the shared root,
  // which a hand working inside its worktree cannot do.
  const repo = mkRepo();
  commitOnBranch(repo.dir, 'tl-1', 'work.txt', 'the work\n');
  const f = mkLoop({ repo, suite: 'green' });
  plantPkgs(repo, { ws: '^8.0.0' }, { ws: '^8.0.0', 'left-pad': '^1.3.0' });
  f.tstore.save(f.team.root, [{ ...f.one(), state: 'done', loopStep: 'verify', report: 'r', reportedBy: 'team-hand' }]);

  await f.m._runTicketLoop(f.team, 't1');
  await new Promise((r) => setImmediate(r));

  const esc = f.esc();
  assert.strictEqual(esc.length, 1, 'ENTER: exactly one escalation reached the lead');
  assert.match(esc[0].body, /left-pad/, 'the escalation NAMES the dependency, so the lead can install it');
  assert.match(esc[0].body, /added by the branch/, 'and says which direction the difference runs');
  assert.strictEqual(esc[0].target, 'lead');
  assert.strictEqual(f.created.length, 0, 'no reviewer: nothing was verified');
  assert.deepStrictEqual(f.gated.filter((g) => /rejected/.test(g.body)), [],
    'and the hand is NOT sent rework for a dependency it cannot install');
});

test('a branch that DROPS a dependency escalates too, though its suite would go GREEN', async () => {
  // The dangerous direction, and the reason this check is not "escalate on
  // MODULE_NOT_FOUND". A removed dep still resolves out of the linked root tree,
  // so the suite passes over code whose own package.json no longer declares what
  // it imports — a green that would break on a fresh `npm ci`. Nothing downstream
  // of a green suite looks for this.
  const repo = mkRepo();
  commitOnBranch(repo.dir, 'tl-1', 'work.txt', 'the work\n');
  const f = mkLoop({ repo, suite: 'green' });
  plantPkgs(repo, { ws: '^8.0.0', 'left-pad': '^1.3.0' }, { ws: '^8.0.0' });
  f.tstore.save(f.team.root, [{ ...f.one(), state: 'done', loopStep: 'verify', report: 'r', reportedBy: 'team-hand' }]);

  await f.m._runTicketLoop(f.team, 't1');
  await new Promise((r) => setImmediate(r));

  const esc = f.esc();
  assert.strictEqual(esc.length, 1, 'ENTER: it escalated despite a green suite');
  assert.match(esc[0].body, /left-pad/);
  assert.match(esc[0].body, /dropped by the branch/);
  assert.strictEqual(f.created.length, 0, 'and the green did NOT reach a reviewer');
});

test('an unchanged dependency set reaches the reviewer exactly as before', async () => {
  // The other half of the pair: without this the check above is satisfiable by a
  // rule that escalates every ticket, and the whole loop would stop.
  const repo = mkRepo();
  commitOnBranch(repo.dir, 'tl-1', 'work.txt', 'the work\n');
  const f = mkLoop({ repo, suite: 'green' });
  plantPkgs(repo, { ws: '^8.0.0' }, { ws: '^8.0.0' });
  f.tstore.save(f.team.root, [{ ...f.one(), state: 'done', loopStep: 'verify', report: 'r', reportedBy: 'team-hand' }]);

  await f.m._runTicketLoop(f.team, 't1');
  await new Promise((r) => setImmediate(r));

  assert.deepStrictEqual(f.esc(), [], 'an identical dependency set is not a difference');
  assert.strictEqual(f.created.length, 1, 'ENTER: the reviewer was spawned, so the green path still runs');
});

test('a VERSION RANGE change is a difference too, not just a missing name', async () => {
  // A name-only comparison reads a re-ranged dep as unchanged and verifies the
  // branch against whatever version the root happens to have installed.
  const repo = mkRepo();
  commitOnBranch(repo.dir, 'tl-1', 'work.txt', 'the work\n');
  const f = mkLoop({ repo, suite: 'green' });
  plantPkgs(repo, { ws: '^8.0.0' }, { ws: '^9.0.0' });
  f.tstore.save(f.team.root, [{ ...f.one(), state: 'done', loopStep: 'verify', report: 'r', reportedBy: 'team-hand' }]);

  await f.m._runTicketLoop(f.team, 't1');
  await new Promise((r) => setImmediate(r));

  const esc = f.esc();
  assert.strictEqual(esc.length, 1, 'ENTER: it escalated');
  assert.match(esc[0].body, /root has \^8\.0\.0, branch wants \^9\.0\.0/,
    'and names BOTH ranges — the lead cannot act on "ws differs"');
});

test('a repo with no package.json at all still runs its suite', async () => {
  // Guards the guard: every subject that predates this check has no package.json
  // in either tree, and a comparison that treated "unreadable" as "different"
  // would escalate all of them. The 50 subjects above are that assertion; this
  // one states it on purpose so it cannot be deleted by accident.
  const repo = mkRepo();
  commitOnBranch(repo.dir, 'tl-1', 'work.txt', 'the work\n');
  const f = mkLoop({ repo, suite: 'green' });
  assert.ok(!fsReal.existsSync(pathReal.join(repo.dir, 'package.json')),
    'ENTER: neither tree has a package.json, which is the case under test');
  f.tstore.save(f.team.root, [{ ...f.one(), state: 'done', loopStep: 'verify', report: 'r', reportedBy: 'team-hand' }]);

  await f.m._runTicketLoop(f.team, 't1');
  await new Promise((r) => setImmediate(r));

  assert.deepStrictEqual(f.esc(), [], 'an absent package.json is not a dependency difference');
  assert.strictEqual(f.created.length, 1, 'the reviewer was spawned');
});

test('a DANGLING node_modules link names the dangle, not "could not link"', async () => {
  // fs.existsSync FOLLOWS symlinks, so a link whose target is gone (a root
  // `npm install` mid-flight) reads as ABSENT. The symlinkSync that follows then
  // fails EEXIST, and the escalation blames the link step for a tree that HAS
  // the link and is missing the TARGET — an error naming the wrong fix.
  const repo = mkRepo();
  commitOnBranch(repo.dir, 'tl-1', 'work.txt', 'the work\n');
  const f = mkLoop({ repo, suite: 'green' });
  const link = pathReal.join(repo.dir, 'wt', 'node_modules');
  fsReal.symlinkSync(pathReal.join(repo.dir, 'gone-node_modules'), link);
  assert.ok(!!fsReal.lstatSync(link) && !fsReal.existsSync(link),
    'ENTER: the link EXISTS and does not RESOLVE — the exact state the two calls disagree about');
  f.tstore.save(f.team.root, [{ ...f.one(), state: 'done', loopStep: 'verify', report: 'r', reportedBy: 'team-hand' }]);

  await f.m._runTicketLoop(f.team, 't1');
  await new Promise((r) => setImmediate(r));

  const esc = f.esc();
  assert.strictEqual(esc.length, 1, 'ENTER: it escalated');
  assert.match(esc[0].body, /does not resolve/, 'the escalation names the DANGLE');
  assert.ok(!/could not link node_modules/.test(esc[0].body),
    'and does not blame the link step, which never ran and is not the fix');
});

// ── t362: the lead can SEE a loop rejection, and can add to one ─────────────
//
// Two defects, one region. (a) the well-behaved rejection — suite red, hand
// alive, rework delivered — reached the lead through nothing at all: the only
// lead-facing signal on this path is the call site's escalation, which fires
// exactly when delivery FAILED. (b) a lead `task reject` racing that rejection
// bounced off a `state === 'done'` guard the loop had already invalidated, and
// its must-fixes went to a spill file nobody reads.
//
// The subjects below are written against the shape of the fix, not its text:
// each one names the arm it measures, because "a message reached the lead" is
// also true of an escalation, and the whole point of (a) is that a rejection
// must NOT read as one.

// The lead's rejection notice, isolated from the escalation channel: both go to
// the lead, and a filter that caught either would let one substitute for the
// other — exactly the confusion this ticket is about.
const rejNotice = (f) => f.gated.filter((g) => g.target === 'lead' && /REJECTED by the loop/.test(g.body));

test('t362: a DELIVERED rejection reaches the lead too, over the real verify path', async () => {
  // Driven through _runTicketLoop rather than by calling _rejectTicketFromLoop
  // directly: a notice the call site can no longer reach is worth nothing, and a
  // direct call cannot tell the difference.
  const repo = mkRepo();
  commitOnBranch(repo.dir, 'tl-1', 'work.txt', 'the work\n');
  const f = mkLoop({ repo, suite: 'red' });
  f.tstore.save(f.team.root, [{ ...f.one(), state: 'done', loopStep: 'verify', report: 'r', reportedBy: 'team-hand' }]);

  await f.m._runTicketLoop(f.team, 't1');
  await new Promise((r) => setImmediate(r));

  const notice = rejNotice(f);
  assert.strictEqual(notice.length, 1, 'ENTER: exactly one rejection notice reached the lead');
  // The four fields the lead decides on without opening anything.
  assert.match(notice[0].body, /ticket t1/, 'which ticket');
  assert.match(notice[0].body, /team-hand/, 'which seat it went back to');
  assert.match(notice[0].body, /round 1/, 'how many rounds deep');
  assert.match(notice[0].body, /the test suite FAILS/, 'and one line of why');
  // The dump stays OUT. The hand has it and the record has it; posting it to the
  // lead on every rejection is the flooding the record/dm split exists to stop.
  assert.doesNotMatch(notice[0].body, /the thing that broke/,
    'the failing test names do NOT ride the lead notice — the hand has them');
  // Still rework, not an escalation. This is the claim the ticket turns on: the
  // lead learns about it WITHOUT the loop reporting that it stopped.
  assert.deepStrictEqual(f.esc(), [], 'a delivered rejection is still not an escalation');
  assert.strictEqual(f.created.length, 0, 'and no reviewer was spawned');
});

test('t362: the notice is NON-URGENT, because the reopen is already durable', () => {
  // Urgency is the difference between a lead that finishes its turn and one that
  // is interrupted; the reopen is on disk before this runs, so the next turn
  // loses nothing. Asserted on the argument, since a hold or a park is an
  // acceptable outcome here and neither is visible in the body.
  const repo = mkRepo();
  const f = mkLoop({ repo });
  const urgencies = [];
  const inner = f.m._gatedDeliver;
  f.m._gatedDeliver = (target, sender, body, urgent, tag, onWrite) => {
    urgencies.push({ target, urgent, body });
    return inner.call(f.m, target, sender, body, urgent, tag, onWrite);
  };
  f.tstore.save(f.team.root, [{ ...f.one(), state: 'done', loopStep: 'verify' }]);

  f.m._rejectTicketFromLoop(f.team, 't1', 'the test suite FAILS on your branch — 3/5 passing');

  const toLead = urgencies.filter((u) => u.target === 'lead' && /REJECTED by the loop/.test(u.body));
  assert.strictEqual(toLead.length, 1, 'ENTER: the lead notice was the row measured');
  assert.strictEqual(toLead[0].urgent, false, 'the lead notice does not interrupt');
  const toSeat = urgencies.filter((u) => u.target === 'team-hand');
  assert.strictEqual(toSeat.length, 1, 'ENTER: the seat got its rework');
  assert.strictEqual(toSeat[0].urgent, true, 'the HAND is still woken — it is the one that must act');
});

test('t362: an UNDELIVERED rejection tells the lead once, as an escalation, not twice', async () => {
  // The pre-existing arm. With no seat the ticket stays done and the call site
  // escalates; adding a second channel here would report one event twice, by two
  // mechanisms, and a lead reading both has to work out they are the same thing.
  const repo = mkRepo();
  commitOnBranch(repo.dir, 'tl-1', 'work.txt', 'the work\n');
  const f = mkLoop({ repo, suite: 'red' });
  f.m.sessions.delete('team-hand');
  f.tstore.save(f.team.root, [{ ...f.one(), state: 'done', loopStep: 'verify', report: 'r', reportedBy: 'team-hand' }]);

  await f.m._runTicketLoop(f.team, 't1');
  await new Promise((r) => setImmediate(r));

  const esc = f.esc();
  assert.strictEqual(esc.length, 1, 'ENTER: the undeliverable rework escalated, as before');
  assert.match(esc[0].body, /no live seat/, 'naming why it could not be sent back');
  assert.deepStrictEqual(rejNotice(f), [],
    'and the delivered-path notice does NOT also fire — one event, one channel');
  // Wording-independent restatement of the same claim. The line above reduces on
  // the notice's own text, so a rename of that text would empty the filter and
  // pass this subject while measuring nothing; counting EVERY delivery to the
  // lead cannot go vacuous that way.
  const toLead = f.gated.filter((g) => g.target === 'lead');
  assert.strictEqual(toLead.length, 1,
    `the lead hears about this ONCE — got ${toLead.length}: ${toLead.map((g) => g.body.slice(0, 40)).join(' | ')}`);
});

test('t362: a notice that THROWS cannot unwind the rejection', () => {
  // The WRAP only — a throwing notice leaves a landed rejection the lead has to
  // poll for, never a lost one. The ordering that wrap depends on is a separate
  // claim and is measured by the subject below, which this one cannot see: a
  // notice hoisted above the save is still wrapped and still passes here.
  const repo = mkRepo();
  const f = mkLoop({ repo });
  f.m._gatedDeliver = (target) => {
    if (target === 'lead') throw new Error('lead delivery exploded');
    return { queued: true };
  };
  f.tstore.save(f.team.root, [{ ...f.one(), state: 'done', loopStep: 'verify' }]);

  const r = f.m._rejectTicketFromLoop(f.team, 't1', 'the test suite FAILS on your branch');

  assert.strictEqual(r.ok, true, 'the rejection still succeeded — the notice is not part of its contract');
  const t = f.one();
  assert.strictEqual(t.state, 'open', 'ENTER: the reopen is durable despite the throw');
  assert.strictEqual(t.reworkRound, 1, 'and the marker survived with it');
});

test('t362: a FAILED save notifies no one — the notice is downstream of the write', () => {
  // The ordering _notifyLeadOfLoopRejection's header calls the invariant, stated
  // as the thing hoisting it would break: a lead told "sent back for rework" about
  // a rejection that never reached disk is worse than silence, because the ticket
  // is still `done` and the lead now believes otherwise.
  const repo = mkRepo();
  const f = mkLoop({ repo });
  f.tstore.save(f.team.root, [{ ...f.one(), state: 'done', loopStep: 'verify' }]);

  // Broken between the load and the save, which is exactly where the seat lookup
  // runs. The store writes through fs-util's REAL fs, so the fixture's injected
  // fs cannot reach it; replacing the board directory with a regular FILE fails
  // the mkdir deterministically, where a chmod would not (root defeats it).
  const board = pathReal.dirname(f.tstore.ticketsPath(f.team.root));
  const inner = f.m._ticketAssigneeSeat.bind(f.m);
  let broke = false;
  f.m._ticketAssigneeSeat = (...args) => {
    const seat = inner(...args);
    if (!broke) {
      broke = true;
      fsReal.rmSync(board, { recursive: true, force: true });
      fsReal.writeFileSync(board, 'not a directory\n');
    }
    return seat;
  };

  const r = f.m._rejectTicketFromLoop(f.team, 't1', 'the test suite FAILS on your branch');

  assert.strictEqual(r.ok, false, 'ENTER: the save really threw — the rejection never landed');
  assert.deepStrictEqual(rejNotice(f), [],
    'the lead is NOT told about a rejection that is not on disk');
  // The whole delivery list, not just the notice filter: everything downstream of
  // the throw is unreachable, and a reduction on the notice text alone would go
  // vacuous under a rename of that text.
  assert.deepStrictEqual(f.gated, [], 'and nothing else was sent either — the seat included');
});

// ── t362 (b): the marker, and the reject that lands on rework ───────────────

test('t362: BOTH rejection transitions stamp the marker, identically', () => {
  // The two transitions are deliberately identical (see _rejectTicketFromLoop's
  // header). A marker written in only one of them would make "was this reopened
  // by a rejection?" depend on WHO rejected, which is the asymmetry the pair
  // exists to prevent — and the loop's rejection is the one that made the lead's
  // reject bounce in the first place.
  const viaLoop = mkLoop({ repo: mkRepo() });
  viaLoop.tstore.save(viaLoop.team.root, [{ ...viaLoop.one(), state: 'done', loopStep: 'verify' }]);
  viaLoop.m._rejectTicketFromLoop(viaLoop.team, 't1', 'suite red');

  const viaLead = mkLoop({ repo: mkRepo() });
  viaLead.tstore.save(viaLead.team.root, [{ ...viaLead.one(), state: 'done', loopStep: 'review' }]);
  viaLead.m._handleTask(viaLead.seat('lead'), { type: 'task', sub: 'reject', id: 't1', who: null, body: 'fix the bound' });

  assert.strictEqual(viaLoop.one().state, 'open', 'ENTER: the loop really reopened it');
  assert.strictEqual(viaLead.one().state, 'open', 'ENTER: the lead really reopened it');
  assert.strictEqual(viaLoop.one().reworkRound, 1, 'the loop stamps the marker');
  assert.strictEqual(viaLead.one().reworkRound, 1, 'and the lead stamps the same one');

  // "Identically" is a claim about the EXPRESSION, and comparing each side to
  // literal 1 cannot see it: a lead transition rewritten to `reworkRound = 1` — a
  // flag — agrees with the counting loop on the first round and disagrees on
  // every one after. The lead's second round is where the two shapes separate,
  // so the subject only measures its own name from here down.
  viaLead.tstore.save(viaLead.team.root, [{ ...viaLead.one(), state: 'done', loopStep: 'review' }]);
  viaLead.m._handleTask(viaLead.seat('lead'), { type: 'task', sub: 'reject', id: 't1', who: null, body: 'and the other bound' });

  assert.strictEqual(viaLead.one().state, 'open', 'ENTER: the second lead rejection reopened it too');
  assert.strictEqual(viaLead.one().reworkRound, 2,
    'the lead COUNTS, exactly as the loop does — a flag written here would still read 1');
});

test('t362: a ticket that never closed carries NO marker, so reject still bounces', () => {
  // The distinction the whole fix rests on. `open` is two different tickets, and
  // widening the guard to accept the state would collapse them — reject would
  // then mean "undo the close" or "replace the spec" depending on where it lands,
  // which is what _taskRespec's header argues against and still holds.
  const repo = mkRepo();
  const f = mkLoop({ repo });   // minted open, never done

  assert.ok(!('reworkRound' in f.one()), 'ENTER: a minted ticket carries no marker');
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'reject', id: 't1', who: null, body: 'the must-fixes' });

  assert.ok(f.injected.some((x) => /reject reopens a DONE ticket; t1 is open/.test(x)),
    'the bounce is unchanged for a ticket that never closed');
  // Nothing left the box as rework. Asserted on the DELIVERY LIST WHOLE rather
  // than on a text filter: a filter that matches nothing is also true of a
  // delivery that happened under different wording.
  assert.deepStrictEqual(f.gated, [],
    'no rework was delivered at all — the ticket was never reopened');
});

test('t362: a lead reject RACING the loop lands as a follow-up, not a bounce', () => {
  // The race the ticket describes: the loop reopened it a moment ago, the lead
  // read the red verify and fired its own must-fixes. Before the marker existed
  // this bounced with "already handled" and spilled the reason to a file nobody
  // reads.
  const repo = mkRepo();
  const f = mkLoop({ repo });
  f.tstore.save(f.team.root, [{ ...f.one(), state: 'done', loopStep: 'verify' }]);
  f.m._rejectTicketFromLoop(f.team, 't1', 'the test suite FAILS on your branch');
  assert.strictEqual(f.one().reworkRound, 1, 'ENTER: the loop reopened it and marked it');
  f.gated.length = 0; f.tags.length = 0; f.injected.length = 0;

  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'reject', id: 't1', who: null, body: 'also fix the bound' });

  const sent = f.gated.filter((g) => g.target === 'team-hand');
  assert.strictEqual(sent.length, 1, 'ENTER: the must-fixes were delivered to the live seat');
  assert.match(sent[0].body, /also fix the bound/, 'carrying the reason verbatim');
  assert.match(sent[0].body, /CLOSE WITH: \[agent:task done /,
    'and the close verb, since the seat still has to close');
  assert.ok(f.injected.some((x) => /delivered to team-hand as a follow-up/.test(x)),
    'the reply says follow-up, not reopen — the lead must not read this as a fresh round');
  assert.ok(!f.injected.some((x) => /reject reopens a DONE ticket/.test(x)),
    'and it is NOT the bounce');

  const t = f.one();
  assert.strictEqual(t.reworkRound, 1, 'a follow-up is not a new rework round — nothing implies a fresh review');
  assert.strictEqual(t.state, 'open', 'the ticket was already open and stays there');
  assert.ok(!('loopStep' in t), 'and the loop still does not hold it');
});

test('t362: a follow-up with no live seat FAILS LOUDLY, and keeps the reason', () => {
  // Same reasoning as the loop's own pre-write seat check: rework nobody receives
  // must never reply success. The reason is spilled so the lead can recover it,
  // which is the one thing the old bounce did right.
  const repo = mkRepo();
  const f = mkLoop({ repo });
  f.tstore.save(f.team.root, [{ ...f.one(), state: 'done', loopStep: 'verify' }]);
  f.m._rejectTicketFromLoop(f.team, 't1', 'the test suite FAILS on your branch');
  assert.strictEqual(f.one().reworkRound, 1, 'ENTER: it is rejection-reopened');
  f.m.sessions.delete('team-hand');
  f.gated.length = 0; f.injected.length = 0;

  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'reject', id: 't1', who: null, body: 'also fix the bound' });

  assert.ok(f.injected.some((x) => /^\[agent:task\] error:/.test(x) && /no live seat/.test(x)),
    'an undeliverable follow-up is an error, never a success reply');
  assert.deepStrictEqual(f.gated, [], 'and nothing was delivered');
  assert.ok(f.injected.some((x) => /spill-stub/.test(x)),
    'the must-fixes are spilled so the lead can recover them');
});

test('t362: a follow-up on a SELF-HELD ticket says the lead holds it, not that nobody does', () => {
  // Where this arises is a SOLO board: `_soloContext` sets `lead = session.name`,
  // so the one seat there is its own lead and every self-held ticket resolves to
  // `seat === team.lead`. The old single arm answered "no live seat holds the
  // ticket" — false exactly where it is most confusing, since the seat reading it
  // IS the holder. Reproduced here by holding the ticket at the lead role, which
  // is the same resolution the solo board reaches.
  const repo = mkRepo();
  const f = mkLoop({ repo, ticketOver: { assignee: 'lead', role: 'lead' } });
  f.tstore.save(f.team.root, [{ ...f.one(), state: 'open', reworkRound: 1 }]);
  assert.strictEqual(f.m._ticketAssigneeSeat(f.team, f.one()), f.team.lead,
    'ENTER: the ticket really resolves to the lead itself');

  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'reject', id: 't1', who: null, body: 'also fix the bound' });

  const errs = f.injected.filter((x) => /^\[agent:task\] error:/.test(x));
  assert.strictEqual(errs.length, 1, 'ENTER: it is still an error — a follow-up to yourself is not delivered');
  assert.match(errs[0], /is holding it/, 'and it names the holder rather than denying there is one');
  assert.doesNotMatch(errs[0], /no live seat/,
    'the false claim is gone: a seat that resolved is not "no live seat"');
  assert.ok(f.injected.some((x) => /spill-stub/.test(x)), 'the payload is still spilled, as before');
  assert.deepStrictEqual(f.gated, [], 'and nothing was delivered');
});

test('t362: a follow-up that does NOT reach the seat leaves the stall stamps alone', () => {
  // The stamps say "this seat was handed work just now", and the watchdog reads
  // them to decide whether an episode is still stalling. Writing them before the
  // delivery attempt buys a failed follow-up a full silent window: the ticket
  // looks freshly touched and the nudge that should fire is deferred over a
  // message nobody received.
  const repo = mkRepo();
  const f = mkLoop({ repo });
  const stamped = Date.now() - 90 * 60 * 1000;
  f.tstore.save(f.team.root, [{
    ...f.one(), state: 'open', reworkRound: 1, lastActivityAt: stamped, nudgedAt: stamped,
  }]);
  f.m._gatedDeliver = () => ({ error: 'no such agent "team-hand"' });

  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'reject', id: 't1', who: null, body: 'also fix the bound' });

  assert.ok(f.injected.some((x) => /^\[agent:task\] error:/.test(x) && /did NOT reach team-hand/.test(x)),
    'ENTER: the delivery really failed and was reported as a failure');
  const t = f.one();
  assert.strictEqual(t.nudgedAt, stamped,
    'the stall episode is NOT reset — the seat was never told, so nothing about it changed');
  assert.strictEqual(t.lastActivityAt, stamped, 'and the activity stamp is untouched for the same reason');
});

test('t362: a DELIVERED follow-up does stamp, so the watchdog does not nudge a seat just handed work', () => {
  // The other half of the pair above: moving the stamps below the delivery must
  // not drop them. A seat that genuinely received must-fixes this second is not
  // stalling, and a stale stamp here would nudge it immediately.
  const repo = mkRepo();
  const f = mkLoop({ repo });
  const stamped = Date.now() - 90 * 60 * 1000;
  f.tstore.save(f.team.root, [{
    ...f.one(), state: 'open', reworkRound: 1, lastActivityAt: stamped, nudgedAt: stamped,
  }]);

  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'reject', id: 't1', who: null, body: 'also fix the bound' });

  const sent = f.gated.filter((g) => g.target === 'team-hand');
  assert.strictEqual(sent.length, 1, 'ENTER: the follow-up really was delivered');
  const t = f.one();
  assert.strictEqual(t.nudgedAt, null, 'the stall episode is cleared on the delivered arm');
  assert.ok(t.lastActivityAt > stamped, 'and the activity stamp moved forward with it');
});

test('t362: a SECOND loop rejection counts the round up, so the lead sees the depth', () => {
  // The counter is why the marker is not a boolean: "the hand is quietly on round
  // 3" is the state the lead is watching for, and a flag cleared on each close
  // would report round 1 forever.
  const repo = mkRepo();
  const f = mkLoop({ repo });
  f.tstore.save(f.team.root, [{ ...f.one(), state: 'done', loopStep: 'verify' }]);
  f.m._rejectTicketFromLoop(f.team, 't1', 'suite red');
  // The seat closes again, and the loop rejects again.
  f.tstore.save(f.team.root, [{ ...f.one(), state: 'done', loopStep: 'verify' }]);
  assert.strictEqual(f.one().reworkRound, 1, 'ENTER: the marker SURVIVED the close — it is not reset per round');
  f.gated.length = 0;
  f.m._rejectTicketFromLoop(f.team, 't1', 'suite still red');

  assert.strictEqual(f.one().reworkRound, 2, 'the second rejection counts up');
  const notice = rejNotice(f);
  assert.strictEqual(notice.length, 1, 'ENTER: the second rejection notified the lead too');
  assert.match(notice[0].body, /round 2/, 'and the lead is told which round it is');
});

// ── t370: the loop's red run preserves its output ──────────────────────────
//
// scripts/test-digest.sh's `save_failing_output` gives the lead's exec grant a
// preserved dump of a failing run. The loop never reaches that script — it
// spawns the BRANCH's scripts/run-tests.js — so its own red run preserved
// nothing, and the loop's rejection is the one failure report that reaches ONLY
// the hand. The evidence nobody else can see was the evidence being dropped.
//
// A shared `~/.clodex/test-failures/last.txt` is deliberately NOT what the loop
// writes: it has one writer today and the loop would be an unattended second,
// so two tickets failing close together would hand a hand another ticket's
// failure. These subjects pin the per-ticket, per-round path instead.

// The preserved file, found the way diffFile() finds the diff — by walking the
// projects root rather than rebuilding the path the code under test computes.
// Rebuilding it would make the assertion agree with the implementation by
// construction and pass over a file written somewhere nobody looks.
function keptFiles(f, home) {
  const hits = [];
  const walk = (d) => {
    let ents = [];
    try { ents = fsReal.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const full = pathReal.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (/^suite-failure-.*\.txt$/.test(e.name)) hits.push(full);
    }
  };
  walk(pathReal.join(home, 'projects'));
  return hits;
}

// Everything the writer could have left behind, published or not — the `.tmp`
// the write-then-rename goes through included. keptFiles() above answers "what
// would a reader find", which is the wrong question for a subject about litter:
// a scratch file that survives is invisible to it by construction.
function keptDebris(home) {
  const hits = [];
  const walk = (d) => {
    let ents = [];
    try { ents = fsReal.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const full = pathReal.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (/^suite-failure-/.test(e.name)) hits.push(full);
    }
  };
  walk(pathReal.join(home, 'projects'));
  return hits;
}

// The name with its timestamp discriminator cut off, so a subject about ROUNDS
// asserts about rounds and not about the clock. The stamp itself is pinned by
// the subject that is about it. A name that does NOT carry one throws here
// rather than reducing to something that quietly compares equal.
function keptStems(f, home) {
  return keptFiles(f, home)
    .map((p) => {
      const m = /^(suite-failure-t\d+-r\d+)-\d{4}-/.exec(pathReal.basename(p));
      assert.ok(m, `every preserved file carries a stamp after its round: ${pathReal.basename(p)}`);
      return m[1];
    })
    .sort();
}

test('t370: a red loop run PRESERVES its full output, and the rejection names the file', async () => {
  const repo = mkRepo();
  commitOnBranch(repo.dir, 'tl-1', 'work.txt', 'the work\n');
  const f = mkLoop({ repo, suite: 'redWithDiff' });
  assert.deepStrictEqual(keptFiles(f, f.home), [],
    'ENTER: nothing is preserved before the run — the assertions below must be about THIS run');
  f.tstore.save(f.team.root, [{ ...f.one(), state: 'done', loopStep: 'verify', report: 'r', reportedBy: 'team-hand' }]);

  await f.m._runTicketLoop(f.team, 't1');
  await new Promise((r) => setImmediate(r));

  const kept = keptFiles(f, f.home);
  assert.strictEqual(kept.length, 1, 'exactly one preserved file is written');
  // The round is in the name for the reason the diff's is: round 1's evidence is
  // what a round 2 failure gets compared against, and it is unrecoverable once
  // the branch moves on.
  assert.match(pathReal.basename(kept[0]), /^suite-failure-t1-r1-\d{4}-\d\d-\d\d.*\.txt$/,
    'the ticket, the round and the stamp are all in the name');

  const body = fsReal.readFileSync(kept[0], 'utf8');
  // The DIAGNOSTICS, not merely the names. The names were already in the
  // rejection message, so a file containing only those would satisfy a
  // non-empty check while preserving nothing the hand did not already have —
  // which is exactly the state this ticket found.
  assert.match(body, /AssertionError \[ERR_ASSERTION\]/, 'the assertion text is preserved');
  assert.match(body, /\+ actual - expected/, 'the diff is preserved');
  assert.match(body, /at TestContext\.<anonymous>/, 'the stack is preserved');
  // The header, so a stale or foreign dump is detectable on sight rather than
  // silently misread as this run's.
  assert.match(body, /# tree:/, 'the header names the tree that ran');
  assert.match(body, /1\/2 passing, 1 failing/, 'and the counts it produced');

  // The hand is TOLD the path. Without this the file exists and the one party
  // who can act on it has to know the convention to find it.
  const sent = f.gated.filter((g) => /rejected/.test(g.body));
  assert.strictEqual(sent.length, 1, 'ENTER: exactly one rejection was delivered');
  assert.ok(sent[0].body.includes(kept[0]),
    `the rejection names the preserved file by absolute path (body: ${sent[0].body.slice(0, 400)})`);
});

test('t370: a SECOND red round writes its own file, so round 1 evidence survives', async () => {
  const repo = mkRepo();
  commitOnBranch(repo.dir, 'tl-1', 'work.txt', 'the work\n');
  const f = mkLoop({ repo, suite: 'redWithDiff' });
  f.tstore.save(f.team.root, [{ ...f.one(), state: 'done', loopStep: 'verify', report: 'r', reportedBy: 'team-hand' }]);
  await f.m._runTicketLoop(f.team, 't1');
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(f.one().reworkRound, 1, 'ENTER: round 1 rejected and counted');

  // The hand closes again and the loop rejects again.
  f.tstore.save(f.team.root, [{ ...f.one(), state: 'done', loopStep: 'verify', report: 'r2', reportedBy: 'team-hand' }]);
  await f.m._runTicketLoop(f.team, 't1');
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(f.one().reworkRound, 2, 'ENTER: round 2 rejected too');

  assert.deepStrictEqual(keptStems(f, f.home), ['suite-failure-t1-r1', 'suite-failure-t1-r2'],
    'each round keeps its own file — round 2 must not overwrite round 1');
});

test('t370: two tickets failing together do not overwrite each other', async () => {
  // The reason this is not the digest's single shared last.txt. The loop is
  // unattended and fires on ticket close, so two tickets closing minutes apart
  // would leave one hand reading the other ticket's failure — confidently wrong,
  // which is worse than an absent file because it gets acted on.
  const repo = mkRepo();
  commitOnBranch(repo.dir, 'tl-1', 'work.txt', 'the work\n');
  const f = mkLoop({ repo, suite: 'redWithDiff' });
  const t1 = f.one();
  f.tstore.save(f.team.root, [
    { ...t1, state: 'done', loopStep: 'verify', report: 'r', reportedBy: 'team-hand' },
    { ...t1, id: 't2', taskDir: 'tasks/loop-fixture-two', state: 'done', loopStep: 'verify', report: 'r', reportedBy: 'team-hand' },
  ]);

  await f.m._runTicketLoop(f.team, 't1');
  await f.m._runTicketLoop(f.team, 't2');
  await new Promise((r) => setImmediate(r));

  assert.deepStrictEqual(keptStems(f, f.home), ['suite-failure-t1-r1', 'suite-failure-t2-r1'],
    'each ticket keeps its own evidence');
  // And each file holds ITS OWN ticket's run, not the last one to finish.
  for (const p of keptFiles(f, f.home)) {
    const id = /suite-failure-(t\d+)-/.exec(pathReal.basename(p))[1];
    assert.match(fsReal.readFileSync(p, 'utf8'), new RegExp(`for ${id}\\.`),
      `${pathReal.basename(p)} names the ticket whose run it holds`);
  }
});

test('t370: a GREEN run preserves nothing and carries no captured output', async () => {
  // The output is carried on the red arm only: a green run's is noise nobody
  // reads, and holding a 64KB string on every passing ticket to never use it is
  // a cost with no reader.
  const repo = mkRepo();
  commitOnBranch(repo.dir, 'tl-1', 'work.txt', 'the work\n');
  const f = mkLoop({ repo, suite: 'green' });
  f.tstore.save(f.team.root, [{ ...f.one(), state: 'done', loopStep: 'verify', report: 'r', reportedBy: 'team-hand' }]);

  await f.m._runTicketLoop(f.team, 't1');
  await new Promise((r) => setImmediate(r));

  assert.strictEqual(f.one().loopStep, 'review', 'ENTER: the green run really reached review');
  assert.deepStrictEqual(keptFiles(f, f.home), [], 'a green run preserves nothing');

  // The second clause of the name, measured DIRECTLY. Asserting only that no
  // file landed cannot see the guard at all: the green arm never calls
  // _writeTicketSuiteFailure, so making `out.output = text` unconditional leaves
  // this subject green while the 64KB string is carried on every passing ticket.
  // A test that cannot reach the state its name describes is the defect class
  // this repo is most careful about, so the claim is pinned where it lives.
  const green = await f.m._runTicketSuite(f.team, f.one());
  assert.strictEqual(green.green, true, 'ENTER: the direct run really is the green arm');
  assert.strictEqual(green.output, '', 'a green run carries no captured output');
});

test('t370: a write failure still rejects, and SAYS why there is no file', async () => {
  // A rejection with no evidence is still a correct rejection — but silently
  // dropping the reason recreates this ticket's own bug one level down: the hand
  // hunts for a file that was never written and is told nothing.
  //
  // The failure is INJECTED because the obvious route to it does not exist: an
  // unresolvable taskDir escalates at CHECK 3, which is hoisted ahead of the
  // suite, so it never reaches this arm. What does reach it is a write that
  // fails after CHECK 3 passed — the task dir removed during a suite run that
  // takes minutes. Stubbing the writer is the honest way to pin the MESSAGE
  // arm without pretending the unreachable path is reachable.
  const repo = mkRepo();
  commitOnBranch(repo.dir, 'tl-1', 'work.txt', 'the work\n');
  const f = mkLoop({ repo, suite: 'redWithDiff' });
  f.m._writeTicketSuiteFailure = () => ({ ok: false, path: null, error: 'ENOENT: the task dir went away' });
  f.tstore.save(f.team.root, [{ ...f.one(), state: 'done', loopStep: 'verify', report: 'r', reportedBy: 'team-hand' }]);

  await f.m._runTicketLoop(f.team, 't1');
  await new Promise((r) => setImmediate(r));

  const sent = f.gated.filter((g) => /rejected/.test(g.body));
  assert.strictEqual(sent.length, 1, 'ENTER: the rejection still reaches the hand');
  assert.match(sent[0].body, /could not be preserved/,
    'it says there is nothing to read, rather than pointing at a missing file');
  assert.match(sent[0].body, /the task dir went away/, 'and carries the underlying reason');
  assert.match(sent[0].body, /probe alpha/, 'the failing names still ride it');
});

test('t370: an EMPTY capture is refused rather than written as a confidently empty file', async () => {
  // t363's own raw-fallback arm exists for this: a present file that says
  // nothing reads as "the runner produced no output", which is a claim about the
  // run rather than about the preservation. Refusing puts the reason in the
  // rejection instead, where it is true.
  const repo = mkRepo();
  const f = mkLoop({ repo });
  const r = await f.m._writeTicketSuiteFailure(f.team, f.one(), { output: '   \n  ', summary: '0/1', cwd: repo.dir });
  assert.strictEqual(r.ok, false, 'an empty capture is not written');
  assert.strictEqual(r.path, null, 'and no path is claimed for it');
  assert.match(r.error, /no captured output/, 'the reason names the empty capture');
  assert.deepStrictEqual(keptFiles(f, f.home), [], 'nothing landed on disk');
});

test('t370 r2: an UNDELIVERABLE rejection still names the preserved file to the lead', async () => {
  // The sharper version of the original bug: not "the output was thrown away"
  // but "the output was kept and nobody was told". The write precedes the reject
  // attempt, so on this arm the file EXISTS while the hand never received
  // anything — the lead is the only remaining reader, which makes the path in
  // the escalation the whole channel rather than a convenience.
  const repo = mkRepo();
  commitOnBranch(repo.dir, 'tl-1', 'work.txt', 'the work\n');
  const f = mkLoop({ repo, suite: 'redWithDiff' });
  f.m.sessions.delete('team-hand');   // no seat to receive the rework
  f.tstore.save(f.team.root, [{ ...f.one(), state: 'done', loopStep: 'verify', report: 'r', reportedBy: 'team-hand' }]);

  await f.m._runTicketLoop(f.team, 't1');
  await new Promise((r) => setImmediate(r));

  const kept = keptFiles(f, f.home);
  assert.strictEqual(kept.length, 1, 'ENTER: the file really was written on the undeliverable path');
  const esc = f.esc();
  assert.strictEqual(esc.length, 1, 'ENTER: it escalated to the lead rather than rejecting');
  assert.ok(esc[0].body.includes(kept[0]),
    `the escalation names the preserved file (body: ${esc[0].body.slice(0, 500)})`);
});

test('t370 r2: the header records the COMMIT, so two rounds are distinguishable', async () => {
  // `# head:` carrying only the branch name makes r1 and r2 differ by timestamp
  // alone — yet the branch MOVED between them, and that movement is the entire
  // content of a round. Without the sha the artifact is a thing you trust rather
  // than read.
  const repo = mkRepo();
  const sha1 = commitOnBranch(repo.dir, 'tl-1', 'work.txt', 'round one\n');
  const f = mkLoop({ repo, suite: 'redWithDiff' });
  // A REAL git worktree with tl-1 checked out, unlike the plain directory the
  // other subjects use. It has to be real here and nowhere else: this is the one
  // claim about what the TREE THAT RAN says about itself, and a plain directory
  // inside the repo resolves to the repo root, reporting `master` — which would
  // make this subject measure the fixture rather than the header.
  const realWt = pathReal.join(repo.dir, 'realwt');
  git(repo.dir, ['worktree', 'add', '-q', realWt, 'tl-1']);
  fsReal.mkdirSync(pathReal.join(realWt, 'scripts'), { recursive: true });
  fsReal.writeFileSync(pathReal.join(realWt, 'scripts', 'run-tests.js'), SUITE_STUBS.redWithDiff);
  assert.strictEqual(git(realWt, ['rev-parse', '--abbrev-ref', 'HEAD']), 'tl-1',
    'ENTER: the worktree really has the ticket branch checked out');
  f.tstore.save(f.team.root, [{
    ...f.one(), state: 'done', loopStep: 'verify', report: 'r', reportedBy: 'team-hand',
    worktree: { ...f.one().worktree, path: realWt },
  }]);
  await f.m._runTicketLoop(f.team, 't1');
  await new Promise((r) => setImmediate(r));

  // The branch MOVES, committed IN THE WORKTREE — which is both what a hand
  // actually does for round 2 and the only way that works here: the branch is
  // checked out by the worktree, so a root-side `git checkout tl-1` is refused.
  fsReal.writeFileSync(pathReal.join(realWt, 'work.txt'), 'round two\n');
  git(realWt, ['add', 'work.txt']);
  git(realWt, ['commit', '-q', '-m', 'the round 2 fix']);
  const sha2 = git(realWt, ['rev-parse', 'HEAD']);
  assert.notStrictEqual(sha1, sha2, 'ENTER: the branch really moved between rounds');
  f.tstore.save(f.team.root, [{ ...f.one(), state: 'done', loopStep: 'verify', report: 'r2', reportedBy: 'team-hand' }]);
  await f.m._runTicketLoop(f.team, 't1');
  await new Promise((r) => setImmediate(r));

  // Keyed by ROUND, which is what this subject is about — the stamp after it
  // varies by construction and indexing on the whole basename would miss both
  // files and leave every assertion below reading undefined.
  const byRound = {};
  for (const p of keptFiles(f, f.home)) {
    const m = /-(r\d+)-\d{4}-/.exec(pathReal.basename(p));
    assert.ok(m, `ENTER: the name carries a round and a stamp: ${pathReal.basename(p)}`);
    byRound[m[1]] = fsReal.readFileSync(p, 'utf8');
  }
  const r1 = byRound.r1;
  const r2 = byRound.r2;
  assert.ok(r1 && r2, 'ENTER: both rounds preserved a file');
  // Each names the commit its own run measured — the assertion is that they
  // DIFFER, which a branch-name-only header cannot satisfy.
  assert.match(r1, new RegExp(`# head:.*${sha1.slice(0, 12)}`), 'round 1 records the commit it measured');
  assert.match(r2, new RegExp(`# head:.*${sha2.slice(0, 12)}`), 'round 2 records ITS commit');
  const headLine = (t) => /# head:.*/.exec(t)[0];
  assert.notStrictEqual(headLine(r1), headLine(r2),
    'the two headers are distinguishable, which is the whole point');
});

test('t370 r3: an UNDELIVERABLE rejection says WHY there is no file, not just when there is one', async () => {
  // The mirror of the round-1 fix. Naming the file when it exists and going
  // silent when it does not leaves the lead — the only reader on this arm —
  // unable to tell "preservation failed" from "nobody thought to look".
  const repo = mkRepo();
  commitOnBranch(repo.dir, 'tl-1', 'work.txt', 'the work\n');
  const f = mkLoop({ repo, suite: 'redWithDiff' });
  f.m.sessions.delete('team-hand');   // nothing to deliver the rework to
  f.m._writeTicketSuiteFailure = async () => ({ ok: false, path: null, error: 'ENOSPC: no space left on device' });
  f.tstore.save(f.team.root, [{ ...f.one(), state: 'done', loopStep: 'verify', report: 'r', reportedBy: 'team-hand' }]);

  await f.m._runTicketLoop(f.team, 't1');
  await new Promise((r) => setImmediate(r));

  const esc = f.esc();
  assert.strictEqual(esc.length, 1, 'ENTER: it escalated to the lead rather than rejecting');
  assert.match(esc[0].body, /could not be preserved/, 'the lead is told the evidence is missing');
  assert.match(esc[0].body, /ENOSPC/, 'and why, so absence is distinguishable from nobody looking');
});

test('t370 r3: a preservation that THROWS cannot eat the rejection', async () => {
  // Structural, not incidental. A sync throw is not catchable by `.catch()`, so
  // an unwrapped call turns a RED suite into an ESCALATION and the hand never
  // receives the rework the whole loop exists to send. The guarantee has to hold
  // regardless of which git module is injected.
  const repo = mkRepo();
  commitOnBranch(repo.dir, 'tl-1', 'work.txt', 'the work\n');
  const f = mkLoop({ repo, suite: 'redWithDiff' });
  f.m._writeTicketSuiteFailure = () => { throw new TypeError('gitWorktree.currentBranch is not a function'); };
  f.tstore.save(f.team.root, [{ ...f.one(), state: 'done', loopStep: 'verify', report: 'r', reportedBy: 'team-hand' }]);

  await f.m._runTicketLoop(f.team, 't1');
  await new Promise((r) => setImmediate(r));

  const sent = f.gated.filter((g) => /rejected/.test(g.body));
  assert.strictEqual(sent.length, 1, 'the hand STILL gets its rework — the throw did not become an escalation');
  assert.strictEqual(sent[0].target, 'team-hand');
  assert.deepStrictEqual(f.esc(), [], 'and the lead is not escalated to instead');
  assert.match(sent[0].body, /could not be preserved/, 'the rejection says the evidence is missing');
  assert.match(sent[0].body, /is not a function/, 'and carries the throw as the reason');
  assert.match(sent[0].body, /probe alpha/, 'the failing names still ride it');
  assert.strictEqual(f.one().state, 'open', 'the ticket is reopened for rework, as a red suite must');
});

test('t370 r3: an accept landing during the PRESERVATION write cannot reopen the ticket', async () => {
  // The await added for the header's git read sits between the freshness
  // re-check and the reject's mutation. Milliseconds, but it is the window the
  // surrounding comment warns about: reopening an ACCEPTED ticket would bump its
  // rework round and put a finished ticket back on the board.
  const repo = mkRepo();
  commitOnBranch(repo.dir, 'tl-1', 'work.txt', 'the work\n');
  const f = mkLoop({ repo, suite: 'redWithDiff' });
  // The accept lands INSIDE the write, which is exactly where the gap is.
  const realWrite = f.m._writeTicketSuiteFailure.bind(f.m);
  f.m._writeTicketSuiteFailure = async (team, ticket, suite) => {
    const r = await realWrite(team, ticket, suite);
    const t = f.one();
    delete t.loopStep;                       // what `task accept` does
    f.tstore.save(f.team.root, [{ ...t, state: 'done' }]);
    return r;
  };
  f.tstore.save(f.team.root, [{ ...f.one(), state: 'done', loopStep: 'verify', report: 'r', reportedBy: 'team-hand' }]);

  await f.m._runTicketLoop(f.team, 't1');
  await new Promise((r) => setImmediate(r));

  const t = f.one();
  assert.strictEqual(t.state, 'done', 'the accepted ticket stays done — it is NOT reopened');
  assert.ok(!('reworkRound' in t), 'and no rework round is stamped onto finished work');
  assert.deepStrictEqual(f.gated.filter((g) => /rejected/.test(g.body)), [],
    'no rejection is delivered for a ticket that is no longer at verify');
});

test('t370 r3: a resolvable branch with an UNRESOLVABLE commit says so, rather than claiming one', async () => {
  // currentBranch returns ok:true with head:null when `rev-parse HEAD` fails, so
  // the naive interpolation writes `# head:  tl-1 ` — a header that claims a
  // commit and carries none, which is worse than admitting the gap because the
  // sha is the half a reader cannot reconstruct.
  const repo = mkRepo();
  commitOnBranch(repo.dir, 'tl-1', 'work.txt', 'the work\n');
  const f = mkLoop({
    repo,
    suite: 'redWithDiff',
    wrapGit: (gw) => ({ ...gw, currentBranch: async () => ({ ok: true, branch: 'tl-1', head: null }) }),
  });
  f.tstore.save(f.team.root, [{ ...f.one(), state: 'done', loopStep: 'verify', report: 'r', reportedBy: 'team-hand' }]);

  await f.m._runTicketLoop(f.team, 't1');
  await new Promise((r) => setImmediate(r));

  const kept = keptFiles(f, f.home);
  assert.strictEqual(kept.length, 1, 'ENTER: the file was still written — a vaguer header beats no dump');
  const head = /# head: .*/.exec(fsReal.readFileSync(kept[0], 'utf8'))[0];
  assert.match(head, /tl-1/, 'the branch it could resolve is still recorded');
  assert.match(head, /commit unresolved/, 'and the missing sha is stated, not left as a trailing space');
  assert.ok(!/# head: {2}tl-1 *$/.test(head), `the header must not claim a commit it does not have (got: ${JSON.stringify(head)})`);
});

// ── t373: the preservation's own failures reach a reader ────────────────────

test('t373: a preservation that THROWS is LOGGED, not only swallowed into the rejection', async () => {
  // The swallow is the guarantee (pinned above) — but a swallow with no log
  // makes a SYSTEMIC break invisible. The throw's text goes only into the
  // rejection body, which reaches the hand; the lead's copy runs through
  // _notifyLeadOfLoopRejection, which forwards `reason.split('\n')[0]` — the
  // suite summary line, never the evidence line. So without this a bad injected
  // gitWorktree or a rename is absent from the record entirely and discoverable
  // only by a hand that happens to read one rejection.
  const repo = mkRepo();
  commitOnBranch(repo.dir, 'tl-1', 'work.txt', 'the work\n');
  const f = mkLoop({ repo, suite: 'redWithDiff' });
  f.m._writeTicketSuiteFailure = () => { throw new TypeError('gitWorktree.currentBranch is not a function'); };
  f.tstore.save(f.team.root, [{ ...f.one(), state: 'done', loopStep: 'verify', report: 'r', reportedBy: 'team-hand' }]);

  await f.m._runTicketLoop(f.team, 't1');
  await new Promise((r) => setImmediate(r));

  // ENTER: the rejection still went out, so this measures the LOG the swallow
  // was missing rather than a throw that ate the rework.
  assert.strictEqual(f.gated.filter((g) => /rejected/.test(g.body)).length, 1,
    'ENTER: the hand still got its rework — the swallow is unchanged');
  const errs = f.logs.filter((l) => l.level === 'error');
  assert.strictEqual(errs.length, 1, `exactly one error is logged (got: ${JSON.stringify(f.logs)})`);
  assert.match(errs[0].msg, /t1/, 'it names the ticket');
  assert.match(errs[0].msg, /is not a function/, 'and carries the throw, which is the half the lead never sees');
});

test('t373: the lead DM really does drop the evidence line, which is why the log is the channel', async () => {
  // The premise of the subject above, measured rather than asserted in prose. If
  // _notifyLeadOfLoopRejection ever started forwarding the whole reason, the log
  // would be a duplicate — so the claim that it is the ONLY lead-facing record
  // has to be pinned where it can break.
  const repo = mkRepo();
  commitOnBranch(repo.dir, 'tl-1', 'work.txt', 'the work\n');
  const f = mkLoop({ repo, suite: 'redWithDiff' });
  f.m._writeTicketSuiteFailure = () => { throw new TypeError('gitWorktree.currentBranch is not a function'); };
  f.tstore.save(f.team.root, [{ ...f.one(), state: 'done', loopStep: 'verify', report: 'r', reportedBy: 'team-hand' }]);

  await f.m._runTicketLoop(f.team, 't1');
  await new Promise((r) => setImmediate(r));

  const toLead = f.gated.filter((g) => g.target === 'lead' && /REJECTED/.test(g.body));
  assert.strictEqual(toLead.length, 1, 'ENTER: the lead really was notified of the rejection');
  assert.ok(!/is not a function/.test(toLead[0].body),
    `the lead's DM carries only the summary line, so the failure is not in it: ${toLead[0].body}`);
});

// ── t375: the published path is written by RENAME, never in place ──────────
//
// t373 closed the truncated-dump hole by CLEANING UP after a failed write: the
// partial file was unlinked, and when the unlink itself failed the path was
// named with a warning. The rename closes the same hole by construction — the
// bytes go to a scratch name and only a completed file is ever moved onto the
// published one — which removes the unremovable-partial state, and with it the
// subject that pinned the warning. That subject is gone from this file
// deliberately: it described a branch that no longer exists.

test('t375: a write that dies mid-file leaves NOTHING at the published path', async () => {
  // ENOSPC and a kill mid-write both leave writeFileSync having produced a
  // PARTIAL file at whatever path it was given. A dump that stops mid-stack
  // reads as complete, so a hand told "could not be preserved" can still find
  // one in its task dir and diagnose off it — worse than no file, because it is
  // acted on. The bytes are written FOR REAL and then the throw raised: a stub
  // that merely threw would leave nothing on disk and pass for the wrong reason.
  const repo = mkRepo();
  commitOnBranch(repo.dir, 'tl-1', 'work.txt', 'the work\n');
  let wroteTo = null;
  const f = mkLoop({
    repo,
    suite: 'redWithDiff',
    wrapFs: (fs) => ({
      ...fs,
      writeFileSync: (p, data, ...rest) => {
        if (!/suite-failure-/.test(String(p))) return fs.writeFileSync(p, data, ...rest);
        wroteTo = String(p);
        fs.writeFileSync(p, String(data).slice(0, 40), ...rest);   // the partial file
        const e = new Error('ENOSPC: no space left on device, write');
        e.code = 'ENOSPC';
        throw e;
      },
    }),
  });
  f.tstore.save(f.team.root, [{ ...f.one(), state: 'done', loopStep: 'verify', report: 'r', reportedBy: 'team-hand' }]);

  await f.m._runTicketLoop(f.team, 't1');
  await new Promise((r) => setImmediate(r));

  assert.ok(wroteTo, 'ENTER: the write really was attempted and really did leave bytes behind');
  assert.match(wroteTo, /\.tmp$/,
    `the partial bytes went to a scratch name, never to the published path (wrote to ${wroteTo})`);
  assert.deepStrictEqual(keptFiles(f, f.home), [],
    'so a reader walking for preserved dumps finds none');
  assert.deepStrictEqual(keptDebris(f.home), [],
    'and the scratch file was cleaned up too, rather than left as litter');

  // The rejection still goes out and still says why there is nothing — the
  // guarantee this must not disturb.
  const sent = f.gated.filter((g) => /rejected/.test(g.body));
  assert.strictEqual(sent.length, 1, 'the hand still gets its rework');
  assert.match(sent[0].body, /could not be preserved/, 'and is told the evidence is missing');
  assert.match(sent[0].body, /ENOSPC/, 'with the reason');
});

test('t375: a failed write claims NO path, so no caller can name a file that is not there', async () => {
  // The direct half of the subject above: the caller's `kept.path` is what a
  // message would print, and naming a path nothing was published to points the
  // reader at a ghost. Measured on the return value, because the undeliverable
  // arm reads exactly this field.
  const repo = mkRepo();
  const f = mkLoop({
    repo,
    wrapFs: (fs) => ({
      ...fs,
      writeFileSync: (p, data, ...rest) => {
        if (!/suite-failure-/.test(String(p))) return fs.writeFileSync(p, data, ...rest);
        fs.writeFileSync(p, String(data).slice(0, 40), ...rest);
        throw new Error('ENOSPC: no space left on device, write');
      },
    }),
  });
  const r = await f.m._writeTicketSuiteFailure(f.team, f.one(), {
    output: 'X.\n✖ probe alpha (1ms)\nTOTALS: 1 pass, 1 fail, 2 tests\n', summary: '1/2', cwd: repo.dir,
  });
  assert.strictEqual(r.ok, false, 'ENTER: the write really failed');
  assert.strictEqual(r.path, null, 'no path is claimed when nothing was published');
  assert.match(r.error, /ENOSPC/, 'the underlying reason still rides the result');
  assert.deepStrictEqual(keptDebris(f.home), [], 'and nothing of the attempt is left on disk');
});

test('t375: a scratch file that CANNOT be removed is still never named to a reader', async () => {
  // The state t373 had to warn about, now harmless — which is the whole value of
  // the rename and has to be pinned rather than asserted in prose. The leftover
  // is at a `.tmp` name no caller was given and no reader walks to, so `ok:false`
  // still means "nothing to read" with no warning for a call site to carry.
  const repo = mkRepo();
  let leftAt = null;
  const f = mkLoop({
    repo,
    wrapFs: (fs) => ({
      ...fs,
      writeFileSync: (p, data, ...rest) => {
        if (!/suite-failure-/.test(String(p))) return fs.writeFileSync(p, data, ...rest);
        leftAt = String(p);
        fs.writeFileSync(p, String(data).slice(0, 40), ...rest);
        throw new Error('ENOSPC: no space left on device, write');
      },
      unlinkSync: (p) => {
        if (!/suite-failure-/.test(String(p))) return fs.unlinkSync(p);
        const e = new Error('EPERM: operation not permitted, unlink');
        e.code = 'EPERM';
        throw e;
      },
    }),
  });
  const r = await f.m._writeTicketSuiteFailure(f.team, f.one(), {
    output: 'X.\n✖ probe alpha (1ms)\nTOTALS: 1 pass, 1 fail, 2 tests\n', summary: '1/2', cwd: repo.dir,
  });
  assert.ok(leftAt && fsReal.existsSync(leftAt), 'ENTER: the partial bytes really are still on disk');
  assert.match(leftAt, /\.tmp$/, 'ENTER: and they are at the scratch name, which is why this is safe');
  assert.strictEqual(r.ok, false, 'still a failure');
  assert.strictEqual(r.path, null, 'no path is named, because nothing readable exists');
  assert.deepStrictEqual(keptFiles(f, f.home), [],
    'and the leftover is invisible to a reader walking for preserved dumps');
});

test('t375: a RENAME that fails publishes nothing and reports the reason', async () => {
  // The failure mode the rename ADDS, so it cannot be the one thing left
  // unpinned: the write succeeded and the publish did not. Nothing may appear at
  // the published path, and the caller must hear why rather than a stale
  // "no captured output".
  const repo = mkRepo();
  const f = mkLoop({
    repo,
    wrapFs: (fs) => ({
      ...fs,
      renameSync: (a, b) => {
        if (!/suite-failure-/.test(String(a))) return fs.renameSync(a, b);
        const e = new Error('EXDEV: cross-device link not permitted, rename');
        e.code = 'EXDEV';
        throw e;
      },
    }),
  });
  const r = await f.m._writeTicketSuiteFailure(f.team, f.one(), {
    output: 'X.\n✖ probe alpha (1ms)\nTOTALS: 1 pass, 1 fail, 2 tests\n', summary: '1/2', cwd: repo.dir,
  });
  assert.strictEqual(r.ok, false, 'a run whose dump never got published is not a success');
  assert.strictEqual(r.path, null, 'nothing is named');
  assert.match(r.error, /EXDEV/, 'the rename failure is the reason reported, not a guess');
  assert.deepStrictEqual(keptDebris(f.home), [], 'and the scratch file is cleaned up');
});

test('t373: a write that produced NOTHING reports its own reason, not the cleanup\'s', async () => {
  // The write can throw BEFORE producing anything (a refused open), and the
  // cleanup then finds no scratch file. That ENOENT must not displace the reason
  // the caller actually needs — the open failure is what a reader can act on.
  const repo = mkRepo();
  const f = mkLoop({
    repo,
    wrapFs: (fs) => ({
      ...fs,
      writeFileSync: (p, data, ...rest) => {
        if (!/suite-failure-/.test(String(p))) return fs.writeFileSync(p, data, ...rest);
        const e = new Error('EACCES: permission denied, open');   // nothing written
        e.code = 'EACCES';
        throw e;
      },
    }),
  });
  const r = await f.m._writeTicketSuiteFailure(f.team, f.one(), {
    output: 'X.\nTOTALS: 1 pass, 1 fail, 2 tests\n', summary: '1/2', cwd: repo.dir,
  });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.path, null, 'nothing was created, so nothing is named');
  assert.match(r.error, /EACCES/, 'the real reason is what the caller reports');
});

// ── t375: an UNRAN run carries its capture out too ─────────────────────────
//
// t370 scoped `output` to the red arm because that was the only consumer then.
// The post-merge run gave the unran arms a consumer: a crash or a timeout there
// REVERTS master exactly as a red suite does, so its output is unreproducible
// for the same reason, and `suite.error` — the only thing carried today — is a
// 300-char last line standing in for a 64KB capture. These pin the carry at the
// source; ticket-auto-merge.test.js pins what the post-merge arm does with it.

test('t375: a run that produced no TOTALS carries its capture, not just a last line', async () => {
  const repo = mkRepo();
  const f = mkLoop({ repo, suite: 'crash' });

  const r = await f.m._runTicketSuite(f.team, f.one());

  assert.strictEqual(r.ran, false, 'ENTER: this really is the never-ran arm, not a red suite');
  assert.match(r.error, /no TOTALS summary/, 'ENTER: and it is the missing-summary path specifically');
  assert.match(r.output, /SyntaxError: Unexpected end of input/,
    'the captured text comes out whole, for a caller that can preserve it');
});

test('t375: a TIMED-OUT run carries its capture too', async () => {
  // The other arm the post-merge revert makes unreproducible, and the one where
  // the loss is worst: a killed run's stdout is everything that had been printed
  // before the wedge, which is the only evidence of WHERE it wedged.
  const repo = mkRepo();
  const f = mkLoop({ repo, suite: 'hang', suiteTimeoutMs: 3000 });
  const kid = pathReal.join(repo.dir, 'kid.marker');
  process.env.T317_KID = kid;
  try {
    const r = await f.m._runTicketSuite(f.team, f.one());
    assert.strictEqual(r.ran, false, 'ENTER: a killed run never ran');
    assert.match(r.error, /did not finish within 3000ms/, 'ENTER: killed by the timeout, not some other fault');
    assert.match(r.output, /TOTALS: 5 pass, 0 fail, 5 tests/,
      'what the wedged run had already printed is carried out');
  } finally {
    delete process.env.T317_KID;
  }
});

test('t375: a GREEN run still carries nothing — the carry did not widen to every run', async () => {
  // The anti-widening guard for the two above. `output` on a green run is a 64KB
  // string held on every passing ticket for a reader that does not exist, and
  // the obvious way to implement the carry (hoisting it above the green check)
  // does exactly that while every subject above stays green.
  const repo = mkRepo();
  const f = mkLoop({ repo, suite: 'green' });

  const r = await f.m._runTicketSuite(f.team, f.one());

  assert.strictEqual(r.green, true, 'ENTER: the green arm really was reached');
  assert.strictEqual(r.output, '', 'a green run carries no captured output');
});

test('t375: a run that printed NOTHING carries nothing, and the writer refuses it', async () => {
  // The boundary the carry must not cross: preserving MORE must not mean writing
  // a file for a run with nothing in it. A present file that says nothing reads
  // as "the runner produced no output" — a claim about the run rather than about
  // the preservation, and the confidently-empty artifact this writer refuses.
  const repo = mkRepo();
  const f = mkLoop({ repo, suite: 'silent' });

  const r = await f.m._runTicketSuite(f.team, f.one());
  assert.strictEqual(r.ran, false, 'ENTER: no summary, so it never ran');
  assert.strictEqual(r.output.trim(), '', 'ENTER: the run really printed nothing to carry');

  const kept = await f.m._writeTicketSuiteFailure(f.team, f.one(), r);
  assert.strictEqual(kept.ok, false, 'the writer refuses it');
  assert.strictEqual(kept.path, null, 'and names no file');
  assert.match(kept.error, /no captured output/, 'saying that is why, rather than inventing a reason');
  assert.deepStrictEqual(keptDebris(f.home), [], 'nothing of it reaches disk, not even a scratch file');
});

test('t375: a SUCCESSFUL write leaves the dump and no scratch file beside it', async () => {
  // The success path's half of the rename. Every failure subject above walks for
  // debris; none of them would notice a `.tmp` surviving a write that WORKED,
  // because they never reach it — and a scratch file accumulating once per red
  // run is litter in the same dir a hand reads its evidence from.
  const repo = mkRepo();
  const f = mkLoop({ repo });
  const r = await f.m._writeTicketSuiteFailure(f.team, f.one(), {
    output: 'X.\n✖ probe alpha (1ms)\nTOTALS: 1 pass, 1 fail, 2 tests\n', summary: '1/2', cwd: repo.dir,
  });
  assert.strictEqual(r.ok, true, 'ENTER: the write really succeeded');
  assert.deepStrictEqual(keptDebris(f.home), [r.path],
    'the published dump is the ONLY suite-failure file on disk');
  assert.match(fsReal.readFileSync(r.path, 'utf8'), /probe alpha/,
    'and it is whole, not the scratch copy under another name');
});

// ── t384: the review step's stall alarm probes the reviewer seat ───────────
//
// The measured false alarm: on t377 the watchdog fired `stalled: the ticket loop
// is stuck at "review"` while clodex-reviewer-377-r1 was demonstrably working —
// 1.27MB of transcript, +135KB in the preceding 8 minutes, a Read call in
// flight. A 39KB diff simply takes longer than the window.
//
// These go through the REAL `_sweepTeamTickets` rather than calling the
// classifier, because the claim under test is that the sweep CONSULTS it. A
// pure-classifier test passes just as well against a sweep that never asks.
//
// Every subject below carries an ENTER assertion that the alarm WOULD have
// fired at that instant — a suppression test whose fixture never reached the
// stall condition passes trivially and asserts nothing at all (t377's journal
// records exactly that mistake being made here).

// A live reviewer seat for `ticketId`, with a transcript of `size` bytes.
// The record fields are the ones `_liveReviewSeatsFor` resolves on, which are the
// same ones review-done routes a verdict on.
function reviewerSeat(f, ticketId, size, name = 'team-reviewer-1-r1') {
  f.persistence.upsert({ name, ephemeral: true, reviewFor: 'lead', reviewTicket: ticketId });
  f.m.sessions.set(name, {
    name, type: 'claude', agentType: 'claude', cwd: f.team.root,
    pty: { pid: 4242 }, activityState: 'idle',
  });
  const dir = pathReal.join(f.home, 'run', name);
  fsReal.mkdirSync(dir, { recursive: true });
  const file = pathReal.join(dir, 'transcript.jsonl');
  fsReal.writeFileSync(file, 'x'.repeat(size));
  return {
    session: f.m.sessions.get(name),
    name,
    grow: (by) => fsReal.appendFileSync(file, 'y'.repeat(by)),
  };
}

// The sweep at `t`, with the reviewer's CPU reading whatever the caller says.
// The SAMPLER is stubbed rather than `childProcess`: what is under test is the
// classification, and a real `ps` would report this process's tree, which is a
// number nobody can make flat on demand — the fixture pid is not even in the
// process table, so an unstubbed sampler returns null and every verdict here
// collapses to `wedged` for the wrong reason.
//
// t399 moved the probe from the CLI pid to the pty's whole process TREE, so the
// stubbed name is `_samplePtyTreeCpuMs`. The number it returns still means the
// same thing to the classifier (accumulated ms), which is why every assertion
// below is unchanged across that move.
function sweepAt(f, t, cpuMs) {
  f.m._samplePtyTreeCpuMs = async () => cpuMs;
  return f.m._sweepTeamTickets(f.team, t);
}

const nudgesOf = (f) => f.gated.filter((g) => g.sender === 'ticket-watchdog');

// A ticket parked at `review`, quiet for an hour — i.e. well past the stall
// window, so the alarm is due on the very next sweep.
function heldAtReview(f, quietFor = 60 * 60 * 1000, at = Date.now()) {
  f.tstore.save(f.team.root, [{
    ...f.one(), state: 'done', loopStep: 'review', lastActivityAt: at - quietFor, nudgedAt: null,
  }]);
}

test('t384: a reviewer whose transcript is GROWING suppresses the stall alarm', async () => {
  const repo = mkRepo();
  const f = mkLoop({ repo });
  const t0 = Date.now();
  heldAtReview(f, 60 * 60 * 1000, t0);
  const rv = reviewerSeat(f, 't1', 1_135_000);

  // Sweep 1 takes the baseline. No previous sample exists, so this one cannot
  // classify anything — and it must not alarm on that ignorance either.
  await sweepAt(f, t0, 50_000);
  assert.strictEqual(nudgesOf(f).length, 0, 'the baseline sweep does not alarm on a seat it has not measured yet');
  assert.ok(rv.session._reviewLiveSample, 'ENTER: the baseline really was taken');

  // The 03:08Z observation: +135KB across 8 minutes. CPU is held FLAT on
  // purpose — every other growth fixture let CPU rise too, and a CPU-only
  // implementation then survived the whole suite because the second signal was
  // covering for the first. Growth must suppress on its own.
  rv.grow(135_000);
  await sweepAt(f, t0 + (8 * 60 * 1000), 50_000);

  assert.strictEqual(nudgesOf(f).length, 0, 'a seat writing 135KB in 8 minutes is not stalled');
  // ENTER — the trap this file's t377 sibling fell into. Without it, a fixture
  // that never reached the alarm would pass this test with the probe deleted.
  const t = f.one();
  assert.strictEqual(t.loopStep, 'review', 'ENTER: the ticket is still held at review');
  assert.strictEqual(ticketInFlight(t), true, 'ENTER: and still in flight, so the sweep considered it');
  assert.strictEqual(t.nudgedAt || null, null,
    'ENTER: no alarm was stamped either — the suppression is real, not a missed pass');
});

test('t384: THE COMPOSING CASE — flat transcript with rising CPU must not alarm', async () => {
  // The mutant-killer. A probe keying on transcript GROWTH alone classifies this
  // as a wedge and fires, which is precisely the false alarm this ticket removes.
  // The numbers are the 03:11Z observation: the file did not move for minutes
  // while CPU went 0:52.00 -> 0:53.13.
  const repo = mkRepo();
  const f = mkLoop({ repo });
  const t0 = Date.now();
  heldAtReview(f, 60 * 60 * 1000, t0);
  const rv = reviewerSeat(f, 't1', 1_270_000);

  await sweepAt(f, t0, parseCpuTime('0:52.00'));
  const sizeAtBaseline = rv.session._reviewLiveSample.size;

  // Deliberately NOT grown: the seat is composing a long message.
  await sweepAt(f, t0 + 40_000, parseCpuTime('0:53.13'));
  // THREE sweeps, not two, and the third is what makes this a mutant-killer
  // again. Since the two-consecutive-wedged rule landed, a growth-only probe
  // reaches only ONE unconfirmed wedge in two sweeps, downgrades it to
  // `unknown`, and passes a two-sweep fixture green — the name would claim a
  // kill it no longer had. The confirmation step moved the boundary this
  // fixture was written against without failing it, the same way it did to the
  // two-seat subject below.
  await sweepAt(f, t0 + 80_000, parseCpuTime('0:54.31'));

  assert.strictEqual(rv.session._reviewLiveSample.size, sizeAtBaseline,
    'ENTER: the transcript really did not grow — this is the shape a growth-only probe calls wedged');
  assert.strictEqual(nudgesOf(f).length, 0, 'CPU is accruing, so the seat is composing, not wedged');
  assert.strictEqual(f.one().nudgedAt || null, null, 'ENTER: and nothing was stamped');
});

test('t384: both signals flat DOES alarm, and names the seat', async () => {
  // The alarm is not removed, only made honest. A reviewer that genuinely wedges
  // must still reach the lead — t377's whole point.
  const repo = mkRepo();
  const f = mkLoop({ repo });
  const t0 = Date.now();
  heldAtReview(f, 60 * 60 * 1000, t0);
  const rv = reviewerSeat(f, 't1', 1_270_000);

  await sweepAt(f, t0, 52_000);
  await sweepAt(f, t0 + (2 * 60 * 1000), 52_000);   // no growth, no CPU
  // ONE wedged classification is not enough since r2: Linux procps reports CPU
  // in whole seconds, so a composing turn can read as exactly 0 for a single
  // sample. The verdict must repeat before it alarms.
  assert.strictEqual(nudgesOf(f).length, 0,
    'ENTER: a single wedged sample is held, not fired — one bad sample must not alarm');
  await sweepAt(f, t0 + (4 * 60 * 1000), 52_000);

  const n = nudgesOf(f);
  assert.strictEqual(n.length, 1, 'a wedged reviewer is still reported, once the verdict repeats');
  assert.match(n[0].body, /loop is stuck at "review"/, 'the step wording survives');
  assert.match(n[0].body, new RegExp(rv.name), 'and now it names the seat to go look at');
  assert.match(n[0].body, /WEDGED/);
  assert.match(n[0].body, /no transcript growth and no CPU/, 'stating both signals, since one alone proves nothing');
});

test('t384: the probe runs ONLY at the review step — other steps are unqualified', async () => {
  // `verify` has no seat behind it. A probe consulted there returns null, and
  // reading null as a verdict would either silence the step or decorate its
  // alarm with a claim about a seat that does not exist.
  const repo = mkRepo();
  const f = mkLoop({ repo });
  const t0 = Date.now();
  f.tstore.save(f.team.root, [{
    ...f.one(), state: 'done', loopStep: 'verify', lastActivityAt: t0 - (60 * 60 * 1000), nudgedAt: null,
  }]);
  let sampled = 0;
  f.m._samplePtyTreeCpuMs = async () => { sampled += 1; return 52_000; };

  await f.m._sweepTeamTickets(f.team, t0);

  const n = nudgesOf(f);
  assert.strictEqual(n.length, 1, 'ENTER: the verify step still alarms exactly as before');
  assert.match(n[0].body, /loop is stuck at "verify"/);
  assert.strictEqual(sampled, 0, 'and no seat was probed, because none is behind this step');
  assert.ok(!/reviewer|WEDGED/.test(n[0].body), 'so the body claims nothing about one');
});

test('t399: a one-off tree-CPU DROP is absorbed by the confirm step', async () => {
  // Tree sums are NOT monotonic the way one pid's TIME is: a child that exits
  // between samples takes its accumulated CPU OUT of the total, so the delta
  // goes negative while the root accrues normally. `cpuAccrued` is a `>=` on
  // that delta, so the drop reads `wedged` — and the two-consecutive rule is
  // the only thing standing between that and an alarm about a healthy seat.
  // Asserted through the REAL sampler rather than a re-implemented downgrade,
  // because a copy of the confirm logic drifts and this is the property that
  // makes the phase-2 wake safe to write.
  const repo = mkRepo();
  const f = mkLoop({ repo });
  const t0 = Date.now();
  heldAtReview(f, 60 * 60 * 1000, t0);
  reviewerSeat(f, 't1', 1_270_000);

  await sweepAt(f, t0, parseCpuTime('4:10.00'));                       // root + a busy child
  await sweepAt(f, t0 + (2 * 60 * 1000), parseCpuTime('0:15.00'));     // the child exited: the sum DROPS
  assert.strictEqual(nudgesOf(f).length, 0,
    'ENTER: the drop alone raised nothing — one non-monotonic step is not a wedge');
  // And the seat is not left latched: CPU accruing again clears it, so the drop
  // cannot combine with a later single bad sample to alarm.
  await sweepAt(f, t0 + (4 * 60 * 1000), parseCpuTime('0:45.00'));
  await sweepAt(f, t0 + (6 * 60 * 1000), parseCpuTime('0:45.00'));
  assert.strictEqual(nudgesOf(f).length, 0,
    'a drop followed by one flat sample is still only one confirmed wedge, which does not alarm');
});

test('t384: a review step with NO live reviewer alarms as before, mentioning no seat', async () => {
  // The seat retired, or never spawned. There is nothing to probe, and the
  // pre-t384 alarm is the right one — silence here would delete the alarm for
  // exactly the case t377 built the loop-held wording for.
  const repo = mkRepo();
  const f = mkLoop({ repo });
  const t0 = Date.now();
  heldAtReview(f, 60 * 60 * 1000, t0);

  await sweepAt(f, t0, 52_000);

  const n = nudgesOf(f);
  assert.strictEqual(n.length, 1, 'ENTER: the alarm fires on the FIRST sweep, with no baseline needed');
  assert.match(n[0].body, /loop is stuck at "review"/);
  assert.ok(!/WEDGED|reviewer team-/.test(n[0].body), 'and invents no seat to blame');
});

test('t384: a reviewer that wedges AFTER a healthy stretch is still caught', async () => {
  // Suppression is per-sweep, not a latch. A `continue` that also stamped the
  // ticket, or a probe consulted once, would buy a wedged seat permanent silence
  // — the failure mode t377's orphan arm documents, arrived at from this side.
  const repo = mkRepo();
  const f = mkLoop({ repo });
  const t0 = Date.now();
  heldAtReview(f, 60 * 60 * 1000, t0);
  const rv = reviewerSeat(f, 't1', 1_000_000);

  await sweepAt(f, t0, 50_000);
  rv.grow(100_000);
  await sweepAt(f, t0 + (2 * 60 * 1000), 52_000);
  assert.strictEqual(nudgesOf(f).length, 0, 'ENTER: the healthy stretch really was suppressed');

  // Now it wedges: nothing written, no CPU. Two sweeps, because the verdict must
  // repeat before it alarms (r2 nit 4).
  await sweepAt(f, t0 + (4 * 60 * 1000), 52_000);
  await sweepAt(f, t0 + (6 * 60 * 1000), 52_000);
  assert.strictEqual(nudgesOf(f).length, 1, 'the sweeps after it catch it — suppression is not a latch');
});

test('t384 r2 MUST-FIX: another project\'s reviewer cannot suppress THIS board\'s alarm', async () => {
  // `nextTicketId` maxes over ONE board's list, so `t1` exists on every project
  // simultaneously — two boards sharing a ticket id is the NORMAL case, not an
  // edge. An unscoped walk of the sessions map lets project B's live reviewer
  // answer for project A's `t1` and suppress its alarm, and project A has no
  // seat at all: silent alarm deletion, which is the one outcome the spec
  // forbids. Every sibling resolver in session-manager.js is project-scoped for
  // this reason, and _sweepTeamTickets already documents the same per-BOARD /
  // per-PROJECT hazard for `watchdogMs`.
  const repo = mkRepo();
  const f = mkLoop({ repo });
  const t0 = Date.now();
  heldAtReview(f, 60 * 60 * 1000, t0);

  // A live, HEALTHY reviewer for `t1` — belonging to a DIFFERENT project. Its
  // cwd is a separate git repo, so `_projectRootFor` resolves it elsewhere.
  const other = mkRepo();
  const name = 'other-reviewer-1-r1';
  f.persistence.upsert({ name, ephemeral: true, reviewFor: 'lead', reviewTicket: 't1' });
  f.m.sessions.set(name, {
    name, type: 'claude', agentType: 'claude', cwd: other.dir,
    pty: { pid: 5150 }, activityState: 'idle',
  });
  const dir = pathReal.join(f.home, 'run', name);
  fsReal.mkdirSync(dir, { recursive: true });
  fsReal.writeFileSync(pathReal.join(dir, 'transcript.jsonl'), 'x'.repeat(500_000));

  // ENTER: the foreign seat is live, carries THIS ticket's id, and is exactly
  // the shape that would suppress — so the assertion below is about scoping,
  // not about a seat that failed to qualify for some other reason.
  assert.ok(f.m.sessions.get(name) && !f.m.sessions.get(name)._dead, 'ENTER: the other project\'s reviewer is live');
  assert.strictEqual(f.persistence.get(name).reviewTicket, 't1', 'ENTER: and it claims the same ticket id');
  assert.notStrictEqual(f.m._projectRootFor(other.dir), f.team.root, 'ENTER: but it belongs to another project');
  assert.deepStrictEqual(f.m._liveReviewSeatsFor(f.team, 't1'), [],
    'the resolver refuses it — this board has no reviewer seat');

  await sweepAt(f, t0, 52_000);

  const n = nudgesOf(f);
  assert.strictEqual(n.length, 1, 'the seatless board still alarms — no foreign seat can silence it');
  assert.match(n[0].body, /loop is stuck at "review"/);
  assert.ok(!new RegExp(name).test(n[0].body), 'and the alarm names no seat, because this board has none');
});

test('t384 r2: with two seats on one ticket, ANY live one suppresses', async () => {
  // `keepHold` leaves a round-1 seat alive still carrying `reviewTicket` while
  // round 2 runs, so two records legitimately share one id. A first-match probe
  // reads whichever the map yields first and can call a working round-2 seat
  // wedged because a stranded round-1 seat is flat. Where the resolver is
  // ambiguous this fails toward "alive": the ticket exists to remove false
  // alarms, not to add a new way of producing them.
  const repo = mkRepo();
  const f = mkLoop({ repo });
  const t0 = Date.now();
  heldAtReview(f, 60 * 60 * 1000, t0);

  const stranded = reviewerSeat(f, 't1', 200_000, 'team-reviewer-1-r1');
  const working = reviewerSeat(f, 't1', 900_000, 'team-reviewer-1-r2');
  assert.strictEqual(f.m._liveReviewSeatsFor(f.team, 't1').length, 2,
    'ENTER: both seats really do claim this ticket');

  // THREE sweeps, and the count is load-bearing: a wedge must be seen TWICE
  // before it alarms, so with only two sweeps the stranded seat is still at
  // `unknown` and a first-match implementation would suppress for the WRONG
  // reason — passing this test while carrying the defect. Only a CONFIRMED
  // stranded wedge discriminates the two.
  await sweepAt(f, t0, 52_000);
  working.grow(120_000);
  await sweepAt(f, t0 + (2 * 60 * 1000), 52_000);
  working.grow(120_000);
  await sweepAt(f, t0 + (4 * 60 * 1000), 52_000);

  assert.strictEqual(stranded.session._reviewWedgedOnce, true,
    'ENTER: the stranded seat really is at a CONFIRMED wedge — it would alarm on its own');
  assert.ok(stranded.session._reviewLiveSample, 'ENTER: and it really was sampled, not skipped');
  // What this proves, precisely: a CONFIRMED wedge on one seat does not alarm
  // while a sibling exists that is not wedged. The sibling suppresses on
  // `unknown`, not on `moving` — the early return on the stranded seat's
  // `unknown` in sweeps 1 and 2 meant the working seat was never sampled, so
  // sweep 3 is its first. That is weaker than the comment above describes, and
  // deliberately left alone: growing the working seat earlier would re-open the
  // fixture that just caught mutant J, and a first-match probe still fails here
  // either way because it never reaches the sibling at all.
  assert.strictEqual(nudgesOf(f).length, 0,
    'a confirmed wedge is not reported while a sibling seat is anything but wedged');
});

test('t384 r2: a too-short gap does not reset the baseline — the coupling is latency, not silence', async () => {
  // MIN_GAP_MS (30s) must stay below the watchdog's sweep interval (60s), and
  // nothing enforces that across the two files. If a sweep interval below 30s
  // were configured and each sample overwrote the baseline, no pair could ever
  // span the minimum: every probe answers `unknown`, the caller defers on
  // `unknown`, and the review alarm is gone permanently with no error and no log
  // line — this ticket's own failure mode, one layer up.
  //
  // Keeping the older baseline makes the gap GROW until it qualifies, so the
  // constraint enforces itself instead of resting on a comment.
  const repo = mkRepo();
  const f = mkLoop({ repo });
  const t0 = Date.now();
  heldAtReview(f, 60 * 60 * 1000, t0);
  const rv = reviewerSeat(f, 't1', 1_000_000);

  await sweepAt(f, t0, 50_000);
  const baseline = rv.session._reviewLiveSample;
  assert.ok(baseline, 'ENTER: a baseline was taken');

  // Three sweeps 10s apart — every gap below MIN_GAP_MS.
  await sweepAt(f, t0 + 10_000, 50_000);
  await sweepAt(f, t0 + 20_000, 50_000);
  assert.strictEqual(rv.session._reviewLiveSample.at, baseline.at,
    'the baseline is KEPT, so the measurable gap keeps growing');

  // 40s past the baseline: now the pair spans MIN_GAP_MS and classifies. Flat
  // transcript, flat CPU — a wedge, held once, then confirmed.
  await sweepAt(f, t0 + 40_000, 50_000);
  await sweepAt(f, t0 + 80_000, 50_000);
  assert.strictEqual(nudgesOf(f).length, 1,
    'a readable verdict is eventually reached — deferred, never deleted');
});

test('t384 r3: the idle-alive clause reports the MEASURED flat stretch, not the ticket age', async () => {
  // Two different durations, and the clause names the seat's. `flatFor` only
  // reaches stallMs after the ticket has been quiet for at least twice that, so
  // passing the ticket age says "2h" about a seat measured flat for 40m — a
  // confidently-wrong number in an alarm, which is what stall-evidence.js's
  // header refuses.
  //
  // Pinned HERE and not in the unit test: the formatter is handed a
  // self-consistent pair and cannot tell they came from different clocks. The
  // mismatch only exists at the call site.
  const repo = mkRepo();
  const f = mkLoop({ repo });
  const t0 = Date.now();
  heldAtReview(f, 60 * 60 * 1000, t0);
  const rv = reviewerSeat(f, 't1', 1_000_000);

  await sweepAt(f, t0, 50_000);
  // 40m later: CPU well past the rate threshold, transcript never grown. That is
  // idle-alive — burning CPU for longer than the whole stall window with nothing
  // written — and it is the only verdict whose clause carries a duration.
  await sweepAt(f, t0 + (40 * 60 * 1000), 60_000);

  const n = nudgesOf(f);
  assert.strictEqual(n.length, 1, 'ENTER: the alarm fired, so there is a clause to inspect');
  assert.match(n[0].body, /is running \(CPU is accruing\)/, 'ENTER: and it is the idle-alive clause');
  assert.match(n[0].body, /no progress for 2h/, 'the TICKET has been quiet for 100m');
  assert.match(n[0].body, /written nothing for 40m/, 'but the SEAT was measured flat for 40m');
  assert.ok(!/written nothing for 2h/.test(n[0].body),
    'the seat clause must not borrow the ticket clock — that is the confidently-wrong field');
});

test('t384 r3: a too-short gap does not CLEAR a wedge confirmation either', async () => {
  // The same trap as the subject above, one layer over, and introduced by the
  // fix for it: `_reviewWedgedOnce` is new state, and new defensive state needs
  // the defence the old state just got. Clearing the flag on `unknown` means an
  // all-short-gap cadence alternates wedged/unknown forever — the flag is reset
  // before it can ever be read a second time, so the confirmation never
  // completes and the alarm is gone permanently. Silent alarm deletion, which is
  // the one outcome this ticket forbids.
  //
  // Every sweep here is 10s apart, all below MIN_GAP_MS.
  const repo = mkRepo();
  const f = mkLoop({ repo });
  const t0 = Date.now();
  heldAtReview(f, 60 * 60 * 1000, t0);
  const rv = reviewerSeat(f, 't1', 1_000_000);

  await sweepAt(f, t0, 50_000);
  await sweepAt(f, t0 + 10_000, 50_000);
  await sweepAt(f, t0 + 20_000, 50_000);
  // 30s past the kept baseline: the first pair that spans MIN_GAP_MS. Flat on
  // both signals, so this is a wedge — held, not fired.
  await sweepAt(f, t0 + 30_000, 50_000);
  assert.strictEqual(rv.session._reviewWedgedOnce, true,
    'ENTER: a wedge really was seen and recorded — the fixture reached the state it names');
  assert.strictEqual(nudgesOf(f).length, 0, 'ENTER: and one wedge alone does not alarm');

  // The short-gap sweep that used to wipe it. `unknown` means "could not read",
  // which is neither a confirmation nor a refutation.
  await sweepAt(f, t0 + 40_000, 50_000);
  assert.strictEqual(rv.session._reviewWedgedOnce, true,
    'an unreadable sample must not clear a wedge that was already measured');

  await sweepAt(f, t0 + 50_000, 50_000);
  await sweepAt(f, t0 + 60_000, 50_000);   // 30s past the new baseline: wedged, confirmed
  assert.strictEqual(nudgesOf(f).length, 1,
    'the confirmation survives the short gaps, so the alarm still eventually fires');
});

// ── t345: a verify escalation is a HOLD, not an exit ───────────────────────
//
// Every verify arm funnelled through `fail()` and, on SUCCESSFUL delivery,
// deleted `loopStep`. That left `state=done` with nothing in flight: `task done`
// bounced ("is done, not open"), the stall sweep skipped it forever, and the only
// verb that moved it was `task reject` — which increments `reworkRound` and
// records a rejection that did not happen.
//
// The asymmetry was inside ONE function: the suite-RED arm calls
// `_rejectTicketFromLoop` and reaches the hand, while `commits-on-branch` called
// `fail()` and stranded. Both are "the hand must do something more".
//
// These subjects assert the RE-ENTRY, not merely the state field. A ticket that
// transitions correctly but never spawns a review is the same defect wearing a
// different label, so every recovery subject below asserts `created.length`.

// The stranded shape, built the way the loop builds it: a real 0-commit branch
// through the real verify path, never by writing the fields by hand. A fixture
// that planted `verifyHold` itself would pass against code that never sets it.
async function strand(f) {
  f.tstore.save(f.team.root, [{ ...f.one(), state: 'done', loopStep: 'verify', report: 'r', reportedBy: 'team-hand' }]);
  await f.m._runTicketLoop(f.team, 't1');
  await new Promise((r) => setImmediate(r));
}

test('t345: a DELIVERED verify escalation keeps the ticket in flight', async () => {
  const repo = mkRepo();   // zero commits on tl-1 — CHECK 1 fails
  const f = mkLoop({ repo });

  await strand(f);

  assert.strictEqual(f.esc().length, 1, 'ENTER: the verify arm escalated, and it was DELIVERED');
  const t = f.one();
  assert.strictEqual(t.state, 'done', 'the ticket is not reopened — no rejection happened');
  // The assertion that must fail before the fix: the delivered arm used to
  // `_setLoopStep(..., null)` here, and the ticket fell out of flight.
  assert.strictEqual(t.loopStep, 'verify', 'the hold stays at the step that failed');
  assert.strictEqual(ticketInFlight(t), true,
    'in-flight is the property that matters: it is what the sweep and the re-entry both read');
});

test('t345: the escalation is STAMPED on the record, not only DMed', async () => {
  // The _stampMergeError precedent: the DM is the arm that can fail, so the board
  // must carry what the message may not. Stamped BEFORE the delivery for that
  // reason — a stamp written after a throw in the DM is a stamp never written.
  const repo = mkRepo();
  const f = mkLoop({ repo });

  await strand(f);

  const t = f.one();
  assert.ok(t.verifyHold, 'ENTER: the hold is recorded');
  assert.strictEqual(t.verifyHold.step, 'verify: commits-on-branch', 'it names the check that failed');
  assert.match(t.verifyHold.evidence, /0 commits beyond/, 'and carries the evidence, so the board does not lie');
  assert.ok(t.verifyHold.at > 0, 'and when');
});

test('t345: task done RE-ENTERS the loop on a held ticket and REACHES A REVIEWER', async () => {
  // THE SUBJECT. Not "the state changed" — the whole point is that the review
  // actually happens. A recovery that transitions correctly and spawns nothing is
  // the same defect with a new label.
  const repo = mkRepo();
  const f = mkLoop({ repo });

  await strand(f);
  assert.strictEqual(f.created.length, 0, 'ENTER: nothing was spawned on the red check');

  // The hand fixes exactly what the escalation named, and closes again.
  commitOnBranch(repo.dir, 'tl-1', 'work.txt', 'the work\n');
  f.m._handleTask(f.seat('team-hand'), { type: 'task', sub: 'done', id: 't1', who: null, body: 'committed it this time' });
  for (let i = 0; i < 40 && f.created.length === 0; i++) await new Promise((r) => setTimeout(r, 25));

  assert.strictEqual(f.created.length, 1, 'the re-entry reached an actual reviewer spawn');
  const t = f.one();
  assert.strictEqual(t.loopStep, 'review', 'and the ticket advanced past verify');
  assert.strictEqual(t.state, 'done', 'it was never reopened — no fake rejection');
  assert.strictEqual(Number(t.reworkRound) || 0, 0, 'and no rework round was invented');
  assert.ok(!('verifyHold' in t), 'the hold is cleared once the loop moves past it');
});

test('t345: the re-entry replaces the report, so the reviewer reads the CURRENT one', async () => {
  const repo = mkRepo();
  const f = mkLoop({ repo });

  await strand(f);
  commitOnBranch(repo.dir, 'tl-1', 'work.txt', 'the work\n');
  f.m._handleTask(f.seat('team-hand'), { type: 'task', sub: 'done', id: 't1', who: null, body: 'ROUND TWO REPORT' });
  for (let i = 0; i < 40 && f.created.length === 0; i++) await new Promise((r) => setTimeout(r, 25));

  assert.strictEqual(f.one().report, 'ROUND TWO REPORT', 'the record carries the report that describes the tree being reviewed');
});

test('t345: a re-entry that STILL fails re-escalates and re-holds, not strands', async () => {
  // The second round must not be worse than the first: the hand may fix the wrong
  // thing, and a hold that survives only one round is the same stranding delayed.
  const repo = mkRepo();
  const f = mkLoop({ repo });

  await strand(f);
  // Nothing committed — the same check fails again.
  f.m._handleTask(f.seat('team-hand'), { type: 'task', sub: 'done', id: 't1', who: null, body: 'I think it is fine now' });
  for (let i = 0; i < 40 && f.esc().length < 2; i++) await new Promise((r) => setTimeout(r, 25));

  assert.strictEqual(f.esc().length, 2, 'ENTER: the second attempt escalated too');
  const t = f.one();
  assert.strictEqual(t.loopStep, 'verify', 'and the hold is still there for a third attempt');
  assert.ok(t.verifyHold, 'still stamped');
});

test('t345: the hold is CLEARED when a later run goes green — the finally, not the fail arm', async () => {
  // Aimed at the `finally` specifically, which is why it strands FIRST. Asserting
  // "a clean run carries no stamp" on a ticket that never failed a check is
  // nearly vacuous: there is nothing to clear, so it passes against code with no
  // clear at all. The stamp has to EXIST before the green run for this to be a
  // test of the clearing.
  //
  // A stamp surviving a green run is not cosmetic: the sweep reads it, so the
  // ticket would alarm "escalated, waiting for someone to act" while its review
  // is out — an alarm about a check that has already passed.
  const repo = mkRepo();
  const f = mkLoop({ repo });

  await strand(f);
  assert.ok(f.one().verifyHold, 'ENTER: the stamp is on the record before the green run');

  commitOnBranch(repo.dir, 'tl-1', 'work.txt', 'the work\n');
  f.tstore.save(f.team.root, [{ ...f.one(), loopStep: 'verify' }]);
  await f.m._runTicketLoop(f.team, 't1');
  await new Promise((r) => setImmediate(r));

  assert.strictEqual(f.created.length, 1, 'ENTER: this run went green and reached a reviewer');
  assert.ok(!('verifyHold' in f.one()), 'the stamp is gone — nobody owes this ticket a check any more');
});

test('t345: a reject on a held ticket still works, and clears the hold', async () => {
  // The lead's escape hatch is not removed — a genuine "this needs rework" is
  // still a rejection. It must not leave the stamp behind: a reopened ticket
  // carrying a verify hold would re-alarm about a check that is no longer pending.
  const repo = mkRepo();
  const f = mkLoop({ repo });

  await strand(f);
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'reject', id: 't1', who: null, body: 'do it differently' });

  const t = f.one();
  assert.strictEqual(t.state, 'open', 'ENTER: the reject reopened it');
  assert.ok(!('verifyHold' in t), 'and took the hold with it');
});

test('t345: an accept on a held ticket clears the hold too', async () => {
  const repo = mkRepo();
  const f = mkLoop({ repo });

  await strand(f);
  // Awaited DIRECTLY, not driven through `_handleTask`: accept is the one task
  // verb that is async, and the sync handler fires it unawaited. Reading the
  // record straight after the handler returns reads it BEFORE the accept has
  // written — a fixture that asserts on a state the code has not reached yet.
  await f.m._taskAccept(f.seat('lead'), f.team, { type: 'task', sub: 'accept', id: 't1', who: null, body: '' }, () => {});

  const t = f.one();
  assert.ok(!('verifyHold' in t), 'an accepted ticket owes nobody a verify');
  assert.ok(!('loopStep' in t) || t.loopStep == null, 'and is not held');
});

test('t345: the sweep re-alarms a held ticket, SAYING it is an escalation', async () => {
  // It must not read as a stall: they have different recoveries, and the sweep
  // already documents that an unmarked repeat invites the lead to re-answer what
  // it already answered.
  const repo = mkRepo();
  const f = mkLoop({ repo });

  await strand(f);
  const old = Date.now() - (60 * 60 * 1000);
  f.tstore.save(f.team.root, [{ ...f.one(), lastActivityAt: old, nudgedAt: null }]);
  f.gated.length = 0;
  await f.m._sweepTeamTickets(f.team, Date.now());

  const nudges = f.gated.filter((g) => g.sender === 'ticket-watchdog');
  assert.strictEqual(nudges.length, 1, 'ENTER: the held ticket was re-surfaced at all');
  assert.match(nudges[0].body, /escalated/i, 'the alarm says an escalation is outstanding');
  assert.match(nudges[0].body, /commits-on-branch/, 'and names the check, off the stamp');
  assert.ok(!/loop is stuck at/.test(nudges[0].body),
    'and does NOT read as a dead step — the loop is not stuck, a human owes it an action');
});

test('t345: an ORDINARY closed ticket stays silent — the hold did not widen the sweep', async () => {
  // The discriminator the whole design turns on. A fix that re-alarms on every
  // done ticket satisfies every subject above and destroys the board.
  const repo = mkRepo();
  const f = mkLoop({ repo });
  const old = Date.now() - (60 * 60 * 1000);
  f.tstore.save(f.team.root, [
    { ...f.one(), id: 'held', state: 'done', loopStep: 'verify', verifyHold: { step: 'verify: commits-on-branch', at: old, evidence: 'e' }, lastActivityAt: old, nudgedAt: null },
    { ...f.one(), id: 'finished', state: 'done', lastActivityAt: old, nudgedAt: null },
  ]);

  await f.m._sweepTeamTickets(f.team, Date.now());

  const nudges = f.gated.filter((g) => g.sender === 'ticket-watchdog');
  assert.strictEqual(nudges.length, 1, 'exactly one — the finished ticket is not swept');
  assert.match(nudges[0].body, /\[ticket held\]/, 'ENTER: and it is the held one');
});

test('t345: respec still refuses a held ticket, but routes to the RE-CLOSE, not a reject', async () => {
  // `respec` is gated to `open` and stays that way — it is not an exit from this
  // defect. But its standing advice ("reject it first") is exactly the false
  // rejection this ticket removes, so on a held ticket it must name the real route.
  const repo = mkRepo();
  const f = mkLoop({ repo });

  await strand(f);
  f.injected.length = 0;
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'respec', id: 't1', who: null, body: 'a corrected spec' });

  const said = f.injected.join('\n');
  assert.match(said, /is done/, 'ENTER: it still refused — respec did not become an exit');
  assert.ok(!/reject it first/.test(said), 'and does not prescribe a rejection that did not happen');
  assert.match(said, /verify: commits-on-branch/, 'it names what the ticket is actually waiting on');
});

test('t345: team-review still refuses while a check is RUNNING — the blind window is untouched', async () => {
  // The anti-widening half of the pair below. The guard exists because a ticket
  // at `verify` looks unreviewed for a whole suite run, and a bare team-review in
  // that window spawns a second, unattached reviewer. Narrowing it to skip HELD
  // tickets must not open that window for running ones.
  const repo = mkRepo();
  commitOnBranch(repo.dir, 'tl-1', 'work.txt', 'the work\n');
  const f = mkLoop({ repo });
  f.tstore.save(f.team.root, [{ ...f.one(), state: 'done', loopStep: 'verify', report: 'r', reportedBy: 'team-hand' }]);

  f.m._handleTeamReview(f.seat('lead'), 'have a look at the branch');

  const said = f.injected.join('\n');
  assert.match(said, /in the loop's verify step/, 'a running check still refuses a second reviewer');
  assert.strictEqual(f.created.length, 0, 'ENTER: and nothing was spawned');
});

test('t345: team-review is NOT refused for a HELD ticket — the escape hatch stays open', async () => {
  // The guard tells the lead to wait for the loop's own reviewer. On a held
  // ticket that reviewer is never coming: the loop ran a check, it failed, and it
  // stopped. Refusing here would close the documented escape hatch in exactly the
  // broken state it exists for, and the advice would be false as well.
  const repo = mkRepo();
  commitOnBranch(repo.dir, 'tl-1', 'work.txt', 'the work\n');
  const f = mkLoop({ repo });
  // Held at the TASK-DIR check, so the branch itself is reviewable — the case
  // where a lead plausibly wants a review anyway. Built through the real loop.
  f.tstore.save(f.team.root, [{ ...f.one(), state: 'done', loopStep: 'verify', taskDir: null, report: 'r', reportedBy: 'team-hand' }]);
  await f.m._runTicketLoop(f.team, 't1');
  await new Promise((r) => setImmediate(r));
  assert.ok(f.one().verifyHold, 'ENTER: the ticket really is held');
  f.injected.length = 0;

  f.m._handleTeamReview(f.seat('lead'), 'have a look at the branch');

  const said = f.injected.join('\n');
  assert.ok(!/in the loop's verify step/.test(said),
    'the lead is not told to wait for a reviewer the loop has already given up on');
});

// ── t345 r2: the RE-VERIFY window ──────────────────────────────────────────
//
// `_taskDone`'s re-entry reaches `_runTicketLoop` with `verifyHold` STILL
// STAMPED — nothing clears it between the gate and the call, and the loop's own
// clear is the `finally`, which runs at the END. So for the whole re-run (a full
// suite: minutes, and up to 35 by the caps) the ticket is `loopStep: 'verify'`
// AND `verifyHold` set. Two readers key off exactly that pair, and both read it
// as "stopped, waiting for a human" when it means "running again".
//
// A stub gate is used rather than a slow suite: the window is defined by the
// loop being INSIDE the call, and a real suite would make the test as long as
// the window it is testing.

// Hold the loop open inside the suite check, so the re-verify window can be
// observed from outside. Returns a release fn.
function holdInSuite(f) {
  let release;
  const gate = new Promise((r) => { release = r; });
  const real = f.m._runTicketSuite.bind(f.m);
  f.m._runTicketSuite = async (team, ticket) => { await gate; return real(team, ticket); };
  return release;
}

test('t345 r2: during a RE-VERIFY the team-review guard must still refuse — the blind window is real again', async () => {
  // The loop IS going to spawn a reviewer here, which is exactly the state the
  // guard protects. The r1 narrowing (`!t.verifyHold`) skips it, so a bare
  // team-review is no longer refused and spawns a second, unattached reviewer
  // whose verdict lands nowhere — the precise failure the unnarrowed guard
  // prevented, reintroduced on the recovery path.
  const repo = mkRepo();
  const f = mkLoop({ repo });

  await strand(f);
  commitOnBranch(repo.dir, 'tl-1', 'work.txt', 'the work\n');
  const release = holdInSuite(f);
  f.m._handleTask(f.seat('team-hand'), { type: 'task', sub: 'done', id: 't1', who: null, body: 'fixed it' });
  // Let the re-entry reach the held suite check.
  for (let i = 0; i < 40 && f.one().loopStep !== 'verify'; i++) await new Promise((r) => setTimeout(r, 25));
  await new Promise((r) => setTimeout(r, 50));

  const t = f.one();
  assert.strictEqual(t.loopStep, 'verify', 'ENTER: the loop is inside the re-verify');
  f.injected.length = 0;
  f.m._handleTeamReview(f.seat('lead'), 'have a look at the branch');
  const said = f.injected.join('\n');

  release();
  for (let i = 0; i < 80 && f.created.length === 0; i++) await new Promise((r) => setTimeout(r, 25));

  assert.match(said, /in the loop's verify step/,
    'a RUNNING re-verify is the blind window: the loop will spawn its own reviewer, so a bare one must be refused');
  assert.strictEqual(f.created.length, 1, 'ENTER: and the loop did go on to spawn exactly one reviewer of its own');
});

test('t345 r2: a re-verify that OVERRUNS alarms as a stuck step, not as "waiting for someone to act"', async () => {
  // Someone HAS acted and the loop is running, so the held wording would be false.
  // Reachable because a re-verify may legitimately run 35m
  // (TICKET_SUITE_LOCK_WAIT_MS 20m + 15m running) against a 30m stall window.
  //
  // THE AGE BELOW IS PLANTED, AND THAT IS THE POINT OF THIS SUBJECT — it forces
  // the sweep past its window to inspect the WORDING of an alarm that has been
  // decided on. Read as a claim about the ordinary path it would be a trap, and
  // was one: while `lastActivityAt` was left at the first close, EVERY re-entry
  // alarmed immediately and this subject asserted the body of the alarm that
  // should never have fired. That the ordinary path raises NOTHING is a separate
  // claim, pinned by `t345 r5 MF1` with a real age and no planting. Keep both:
  // this one owns "if it does alarm, it says the right thing".
  const repo = mkRepo();
  const f = mkLoop({ repo });

  await strand(f);
  commitOnBranch(repo.dir, 'tl-1', 'work.txt', 'the work\n');
  const release = holdInSuite(f);
  f.m._handleTask(f.seat('team-hand'), { type: 'task', sub: 'done', id: 't1', who: null, body: 'fixed it' });
  for (let i = 0; i < 40 && f.one().loopStep !== 'verify'; i++) await new Promise((r) => setTimeout(r, 25));
  await new Promise((r) => setTimeout(r, 50));

  // Simulating a suite that has been running longer than the stall window.
  const old = Date.now() - (60 * 60 * 1000);
  f.tstore.save(f.team.root, [{ ...f.one(), lastActivityAt: old, nudgedAt: null }]);
  f.gated.length = 0;
  await f.m._sweepTeamTickets(f.team, Date.now());
  const nudges = f.gated.filter((g) => g.sender === 'ticket-watchdog');

  release();
  for (let i = 0; i < 80 && f.created.length === 0; i++) await new Promise((r) => setTimeout(r, 25));

  // It may legitimately alarm — a re-verify CAN wedge, and silencing that would
  // rebuild the hole this ticket closed. What it must not do is say the loop
  // stopped and is waiting on a human, which sends the lead to act on a running
  // loop and to re-close a ticket that is already being checked.
  assert.strictEqual(nudges.length, 1, 'ENTER: the ticket is in flight and did alarm, so the text below was reached');
  assert.ok(!/waiting for someone to act/.test(nudges[0].body),
    'nobody is being waited on: the hand already acted and the loop is running');
  assert.match(nudges[0].body, /stuck at "verify"/,
    'a re-verify that overruns is a STUCK STEP, which is the alarm that already exists for it');
});

test('t345 r2: the re-entry reply still NAMES the check, though the stamp is already gone', async () => {
  // The clear moved ABOVE the reply, so the field it read is deleted by the time
  // the reply is built. Caught while moving it — unpinned, the seat would be told
  // `re-verifying (was held at "undefined")`, naming nothing, on the one line that
  // confirms the recovery took.
  const repo = mkRepo();
  const f = mkLoop({ repo });

  await strand(f);
  commitOnBranch(repo.dir, 'tl-1', 'work.txt', 'the work\n');
  f.injected.length = 0;
  f.m._handleTask(f.seat('team-hand'), { type: 'task', sub: 'done', id: 't1', who: null, body: 'fixed it' });

  const said = f.injected.join('\n');
  assert.match(said, /re-verifying/, 'ENTER: the re-entry was taken, not a bounce');
  assert.match(said, /was held at "verify: commits-on-branch"/, 'and it names the check that had held it');
  assert.ok(!/undefined/.test(said), 'never "undefined" — that is the clear having run before the read');
});

// ── t345 r4: the recovery must REACH the actor who performs it ─────────────
//
// Reviewer round 1. The state machine was right and the recovery it created was
// never delivered: `_escalateTicket` reaches `team.lead` alone with a body naming
// the step, the evidence and no route, so the only verb the reader had been
// taught for a `done` ticket was `reject` — the false rejection this ticket
// removes. All three must-fixes are one class: a CONSUMER of `verifyHold`
// disagreeing with its producer in a state the field can hold.
//
// The fix is one field. `fail()` knows which arm it is, so it stamps the
// RECOVERY CLASS, and the four readers — escalation body, hand notice, sweep
// alarm, `task done` bounce, `respec` route — all render it through
// HOLD_RECOVERY. These subjects assert they AGREE, which is the property; each
// having its own correct sentence is how they drifted in the first place.

test('t345 r4 MF1: the HAND is told, not only the lead, and told what to do', async () => {
  const repo = mkRepo();   // zero commits: a class (a) hold, the hand's to fix
  const f = mkLoop({ repo });

  await strand(f);

  const toHand = f.gated.filter((g) => g.target === 'team-hand');
  assert.strictEqual(toHand.length, 1, 'ENTER: the seat that owns the branch was told exactly once');
  assert.match(toHand[0].body, /HELD/, 'and told it is HELD, not rejected');
  assert.match(toHand[0].body, /0 commits beyond/, 'with the evidence it has to act on');
  assert.match(toHand[0].body, /close the ticket again/, 'and the route');
  // UNCONDITIONAL, and it was an implication (`!/rework round/ || …`) until t466.
  // That form was safe only while the fact reached the seat from TWO sources:
  // `_notifyHandOfHold` hand-wrote its own copy, which kept "rework round" in the
  // body and forced the right branch. t466 removed the copy, so the code under
  // test now owns the antecedent and can falsify it — reword the arm and the
  // implication passes green while a held seat is never told it was not a
  // rejection. That is the t345 regression returning through its own guard.
  //
  // The two assertions cover what the other cannot: the first fails if the ARM is
  // reworded, the second if the LOCAL sentence is deleted. `/HELD/` above is
  // satisfied by the header tag alone and covers neither.
  //
  // Yes, the first hardcodes the arm's wording into a test — this ticket's own
  // class, one step out. Accepted: `holdRecoveryText` is deliberately unexported
  // (t465 §6, settled), so a test cannot single-source against it. Do NOT "fix"
  // the coupling by weakening this to a looser match: a guard that goes red on a
  // reword is strictly better than one that goes silent on it.
  assert.match(toHand[0].body, /no rework round (is|was) counted/,
    'and it must not read as a rejection — no rework round happened');
  assert.match(toHand[0].body, /NOT rejected/,
    'and told so explicitly — the arm states the positive, this is the negative');
  // The lead is still told: this ADDS a reader, it does not move the escalation.
  assert.strictEqual(f.esc().length, 1, 'the lead still gets its escalation');
});

test('t345 r4 MF1: the tag carries the close verb, mirroring the reject path', async () => {
  const repo = mkRepo();
  const f = mkLoop({ repo });

  await strand(f);

  const i = f.gated.findIndex((g) => g.target === 'team-hand');
  assert.ok(i >= 0, 'ENTER: the hand was delivered to');
  assert.match(f.tags[i], /close with \[agent:task done t1\]/,
    'the tag names the verb, exactly as _rejectTicketFromLoop does — a spilled body is read by its tag alone');
});

test('t345 r4 MF1: the ESCALATION body carries the route too', async () => {
  // The lead is the one holding a `done` ticket whose only taught verb is
  // `reject`. Before this, the route existed only in the sweep body 30 minutes
  // later — so the recovery was undiscoverable at the moment it became available.
  const repo = mkRepo();
  const f = mkLoop({ repo });

  await strand(f);

  assert.match(f.esc()[0].body, /RECOVERY:/, 'ENTER: the escalation names a route at all');
  assert.match(f.esc()[0].body, /close the ticket again/, 'and it is the re-close, for a hand-fixable check');
});

test('t345 r4 MF1: an INFRA hold does not send the hand to re-commit', async () => {
  // Only class (a) reaches the seat. An infra failure is not something a commit
  // fixes, and telling the hand to fix it invites the wrong action — worse than
  // the silence it replaces.
  const repo = mkRepo();
  commitOnBranch(repo.dir, 'tl-1', 'work.txt', 'the work\n');
  const f = mkLoop({ repo, suite: 'crash' });   // the suite could not RUN
  f.tstore.save(f.team.root, [{ ...f.one(), state: 'done', loopStep: 'verify', report: 'r', reportedBy: 'team-hand' }]);

  await f.m._runTicketLoop(f.team, 't1');
  await new Promise((r) => setImmediate(r));

  assert.strictEqual(f.esc().length, 1, 'ENTER: it escalated, and as an infra hold');
  assert.strictEqual(f.one().verifyHold.recovery, 'infra', 'ENTER: classified infra, not hand');
  assert.deepStrictEqual(f.gated.filter((g) => g.target === 'team-hand'), [],
    'the hand is not asked to fix a runner that would not start');
  assert.match(f.esc()[0].body, /could not RUN/, 'and the lead is told what kind of failure it is');
});

test('t345 r4 MF2: the task-dir arm gets a TERMINATING recovery, not "close it again"', async () => {
  // THE SHARPEST of the three. Re-closing re-reads the same `ticket.taskDir`,
  // fails identically, re-stamps and alarms again — forever. The old single
  // sentence prescribed exactly that, and contradicted, two lines below, the
  // evidence it had just quoted.
  const repo = mkRepo();
  commitOnBranch(repo.dir, 'tl-1', 'work.txt', 'the work\n');
  const f = mkLoop({ repo, ticketOver: { spec: 'a title with no artifact path\n\nbody', taskDir: undefined } });
  f.tstore.save(f.team.root, [{ ...f.one(), state: 'done', loopStep: 'verify', report: 'r', reportedBy: 'team-hand' }]);

  await f.m._runTicketLoop(f.team, 't1');
  await new Promise((r) => setImmediate(r));

  const t = f.one();
  assert.strictEqual(t.verifyHold.recovery, 'spec', 'ENTER: classified as a SPEC hold');
  assert.match(f.esc()[0].body, /Re-closing alone will NOT help/,
    'the route must not be the one that cannot terminate');
  assert.match(f.esc()[0].body, /Correct the spec/, 'it names what actually has to change');
  // And the sweep must say the SAME thing, not its own sentence.
  const old = Date.now() - (60 * 60 * 1000);
  f.tstore.save(f.team.root, [{ ...f.one(), lastActivityAt: old, nudgedAt: null }]);
  f.gated.length = 0;
  await f.m._sweepTeamTickets(f.team, Date.now());
  const nudges = f.gated.filter((g) => g.sender === 'ticket-watchdog');
  assert.strictEqual(nudges.length, 1, 'ENTER: the held ticket alarmed');
  assert.match(nudges[0].body, /Re-closing alone will NOT help/,
    'the alarm renders the same field — one renderer, so it cannot contradict the escalation');
});

test('t406: the task-dir EVIDENCE names the defect and leaves the route to the arm', async () => {
  // The other half of the same message. MF2 fixed the RECOVERY arm; the evidence
  // above it kept prescribing "reject … then re-file", so one escalation carried
  // both "reject it" and "do NOT reject, edit in place and close again" two lines
  // apart. A lead following the evidence counts a rework round against a hand
  // that did not write the spec — the misattribution the arm exists to remove.
  const repo = mkRepo();
  commitOnBranch(repo.dir, 'tl-1', 'work.txt', 'the work\n');
  const f = mkLoop({ repo, ticketOver: { spec: 'a title with no artifact path\n\nbody', taskDir: undefined } });
  f.tstore.save(f.team.root, [{ ...f.one(), state: 'done', loopStep: 'verify', report: 'r', reportedBy: 'team-hand' }]);

  await f.m._runTicketLoop(f.team, 't1');
  await new Promise((r) => setImmediate(r));

  const body = f.esc()[0].body;
  assert.match(body, /names no `tasks\/…` path/, 'ENTER: this is the task-dir arm, or the assertions below are about another message');
  assert.match(body, /Re-closing alone will NOT help/, 'ENTER: the spec arm rendered, so there IS a route to contradict');
  // The route is the arm's, and the arm says the opposite of rejecting.
  assert.doesNotMatch(body, /\[agent:task reject t1\]/,
    'the evidence must not prescribe a reject the recovery arm two lines below tells the lead not to do');
  assert.doesNotMatch(body, /re-file/,
    'nor "re-file", which names no verb and reads as "the reject body becomes the new spec" — it does not');
});

test('t345 r4 MF2: respec KEEPS its reject-first route for a spec hold', async () => {
  // The r1 change hid the correct advice behind `!verifyHold`, on precisely the
  // ticket where respec IS the fix. The gate is the CLASS, not the presence.
  const repo = mkRepo();
  commitOnBranch(repo.dir, 'tl-1', 'work.txt', 'the work\n');
  const f = mkLoop({ repo, ticketOver: { spec: 'a title with no artifact path\n\nbody', taskDir: undefined } });
  f.tstore.save(f.team.root, [{ ...f.one(), state: 'done', loopStep: 'verify', report: 'r', reportedBy: 'team-hand' }]);
  await f.m._runTicketLoop(f.team, 't1');
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(f.one().verifyHold.recovery, 'spec', 'ENTER: a spec hold');
  f.injected.length = 0;

  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'respec', id: 't1', who: null, body: 'a corrected spec' });

  const said = f.injected.join('\n');
  assert.match(said, /reject it first/, 'for a SPEC hold, reject-then-respec is the route and must be named');
});

test('t345 r4 MF2: respec does NOT prescribe a rejection for a hand hold', async () => {
  // The r1 property, preserved: on a hand-fixable hold a rejection is the false
  // rejection this ticket removes.
  const repo = mkRepo();
  const f = mkLoop({ repo });

  await strand(f);
  f.injected.length = 0;
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'respec', id: 't1', who: null, body: 'a corrected spec' });

  const said = f.injected.join('\n');
  assert.match(said, /is done/, 'ENTER: respec still refuses — it did not become an exit');
  assert.ok(!/reject it first/.test(said), 'and does not prescribe a rejection that did not happen');
});

test('t345 r4 MF3: a REVIEW-step throw is not stamped, so its recovery is not refused', async () => {
  // `fail()` is also the catch-all's exit, where `atStep` may be 'review'. A hold
  // stamped there leaves `loopStep:'review'` + `verifyHold`, which the re-entry
  // gate refuses while the sweep says to close the ticket again — an alarm whose
  // named recovery the handler bounces.
  const repo = mkRepo();
  commitOnBranch(repo.dir, 'tl-1', 'work.txt', 'the work\n');
  const f = mkLoop({ repo });
  f.tstore.save(f.team.root, [{ ...f.one(), state: 'done', loopStep: 'verify', report: 'r', reportedBy: 'team-hand' }]);
  f.m._spawnTicketReview = () => { throw new Error('spawn exploded'); };

  await f.m._runTicketLoop(f.team, 't1');
  await new Promise((r) => setImmediate(r));

  const t = f.one();
  assert.strictEqual(f.esc().length, 1, 'ENTER: the catch-all escalated');
  assert.match(f.esc()[0].body, /stopped at: review/, 'ENTER: and it is the REVIEW-step throw');
  assert.ok(!('verifyHold' in t), 'no verify hold is stamped for a step that is not a verify step');
  assert.strictEqual(t.loopStep, 'review', 'the hold stays at review, which is where the loop died');
});

test('t345 r4 MF3: the review-step throw KEEPS the hold — pinning the keepHold widening', async () => {
  // Called out as a behaviour change from released code with no subject of its
  // own: `keepHold: true` now reaches the review catch-all. It is the right
  // behaviour — a reviewer seat may still be live and land a verdict — but it was
  // unpinned, so nothing would have caught a revert.
  const repo = mkRepo();
  commitOnBranch(repo.dir, 'tl-1', 'work.txt', 'the work\n');
  const f = mkLoop({ repo });
  f.tstore.save(f.team.root, [{ ...f.one(), state: 'done', loopStep: 'verify', report: 'r', reportedBy: 'team-hand' }]);
  f.m._spawnTicketReview = () => { throw new Error('spawn exploded'); };

  await f.m._runTicketLoop(f.team, 't1');
  await new Promise((r) => setImmediate(r));

  const t = f.one();
  assert.strictEqual(t.loopStep, 'review', 'ENTER: the hold was kept');
  assert.strictEqual(ticketInFlight(t), true,
    'in-flight is what lets a live reviewer still land its verdict, and what keeps the sweep watching');
});

test('t345 r4 MF3: a review-step hold alarms as a STUCK STEP, not as an escalation', async () => {
  // The other half: with no stamp the sweep must fall through to the pre-existing
  // "stuck at review" body, which is accurate there — the loop really did die.
  const repo = mkRepo();
  const f = mkLoop({ repo });
  const old = Date.now() - (60 * 60 * 1000);
  f.tstore.save(f.team.root, [{ ...f.one(), state: 'done', loopStep: 'review', lastActivityAt: old, nudgedAt: null }]);

  await f.m._sweepTeamTickets(f.team, Date.now());

  const nudges = f.gated.filter((g) => g.sender === 'ticket-watchdog');
  assert.strictEqual(nudges.length, 1, 'ENTER: it alarmed');
  assert.match(nudges[0].body, /stuck at "review"/, 'the accurate body for a dead review step');
  assert.ok(!/RECOVERY:/.test(nudges[0].body), 'and it does not prescribe a re-close the handler would refuse');
});

test('t345 r4 nit1: the alarm names a close verb that _taskDone ACCEPTS', async () => {
  // `[agent:task done <id>]` with no report is refused at `:4382` ("done needs a
  // report"), so a lead copying the alarm verbatim got a bounce. Asserted by
  // EXECUTING the prescribed verb through the real handler, not by matching text.
  const repo = mkRepo();
  const f = mkLoop({ repo });

  await strand(f);
  const old = Date.now() - (60 * 60 * 1000);
  f.tstore.save(f.team.root, [{ ...f.one(), lastActivityAt: old, nudgedAt: null }]);
  f.gated.length = 0;
  await f.m._sweepTeamTickets(f.team, Date.now());
  const body = f.gated.filter((g) => g.sender === 'ticket-watchdog')[0].body;

  assert.match(body, /\[agent:task done t1\] <your report>/,
    'ENTER: the alarm prescribes the verb WITH a report placeholder');
  // And the real parser+handler accept what it prescribes.
  commitOnBranch(repo.dir, 'tl-1', 'work.txt', 'the work\n');
  f.injected.length = 0;
  f.m._handleTask(f.seat('team-hand'), { type: 'task', sub: 'done', id: 't1', who: null, body: 'the report' });
  const said = f.injected.join('\n');
  assert.ok(!/needs a report/.test(said), 'the prescribed shape is not refused by the handler');
  assert.match(said, /re-verifying/, 'it is accepted as the re-entry');
});

test('t345 r4 nit3: a huge evidence string is TRUNCATED on the record, not on the DM', async () => {
  // `tickets.json` holds every ticket on the board and is rewritten on every
  // ticket write; a runner error is unbounded. The precedent this stamp follows
  // keeps the step only. The lead still gets the full text in the escalation.
  const repo = mkRepo();
  const f = mkLoop({ repo });
  const huge = 'x'.repeat(5000);
  f.tstore.save(f.team.root, [{ ...f.one(), state: 'done', loopStep: 'verify' }]);
  f.m._stampVerifyHold(f.team, 't1', { step: 'verify: suite', at: Date.now(), evidence: huge, recovery: 'infra' });

  const stored = f.one().verifyHold.evidence;
  assert.ok(stored.length < 500, `the record keeps a bounded string, got ${stored.length}`);
  assert.match(stored, /^x+…$/, 'and marks that it was cut');
});

test('t345 r4 nit2: a re-close does not move the ticket\'s recorded close time', async () => {
  // `_writeTicketCost` and the board both read closedAt/closedBy. A re-entry is
  // the same close being re-verified, so moving them forward would report a close
  // that happened after work the hand did before it.
  const repo = mkRepo();
  const f = mkLoop({ repo });

  // Driven through the REAL handler, not `strand()`: that helper writes the
  // `done` record directly, so no close ever ran and `closedAt` was never
  // stamped — the ENTER guard below caught exactly that, which is what it is for.
  f.m._handleTask(f.seat('team-hand'), { type: 'task', sub: 'done', id: 't1', who: null, body: 'nothing committed yet' });
  for (let i = 0; i < 40 && !f.one().verifyHold; i++) await new Promise((r) => setTimeout(r, 25));
  const first = f.one();
  assert.ok(first.closedAt, 'ENTER: the first close stamped a time');
  assert.ok(first.verifyHold, 'ENTER: and the ticket is held, so the next close is a RE-entry');
  await new Promise((r) => setTimeout(r, 25));

  commitOnBranch(repo.dir, 'tl-1', 'work.txt', 'the work\n');
  f.m._handleTask(f.seat('team-hand'), { type: 'task', sub: 'done', id: 't1', who: null, body: 'fixed' });
  for (let i = 0; i < 40 && f.created.length === 0; i++) await new Promise((r) => setTimeout(r, 25));

  assert.strictEqual(f.one().closedAt, first.closedAt, 'the close time is the FIRST close, not the re-close');
  assert.strictEqual(f.one().closedBy, first.closedBy, 'and so is the closer');
});

test('t345 r4: a LEGACY hold with no recovery class still renders a route everywhere', async () => {
  // The state the field can hold that no arm produces any more: a ticket stamped
  // by the r1/r2 code, sitting on a real board across the upgrade that adds the
  // class. `recovery` is `undefined` there, and every reader renders it —
  // `holdRecoveryText` falls back rather than printing "undefined" or throwing.
  //
  // This is the class of state the reviewer found three of, so it is asserted for
  // ALL FOUR readers rather than the one that happened to be convenient.
  const repo = mkRepo();
  const f = mkLoop({ repo });
  const old = Date.now() - (60 * 60 * 1000);
  f.tstore.save(f.team.root, [{
    ...f.one(),
    state: 'done',
    loopStep: 'verify',
    // No `recovery` key at all — exactly what the previous version wrote.
    verifyHold: { step: 'verify: commits-on-branch', at: old, evidence: '0 commits beyond base' },
    lastActivityAt: old,
    nudgedAt: null,
  }]);

  // READER 1: the sweep alarm.
  await f.m._sweepTeamTickets(f.team, Date.now());
  const nudges = f.gated.filter((g) => g.sender === 'ticket-watchdog');
  assert.strictEqual(nudges.length, 1, 'ENTER: the legacy-held ticket alarmed');
  assert.match(nudges[0].body, /RECOVERY:/, 'the alarm still names a route');
  assert.ok(!/undefined/.test(nudges[0].body), 'and never prints undefined');

  // READER 2: the respec route.
  f.injected.length = 0;
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'respec', id: 't1', who: null, body: 'x' });
  assert.ok(!/undefined/.test(f.injected.join('\n')), 'respec renders it too');

  // READER 3: the re-entry, which must still work on a legacy stamp.
  commitOnBranch(repo.dir, 'tl-1', 'work.txt', 'the work\n');
  f.m._handleTask(f.seat('team-hand'), { type: 'task', sub: 'done', id: 't1', who: null, body: 'fixed' });
  for (let i = 0; i < 40 && f.created.length === 0; i++) await new Promise((r) => setTimeout(r, 25));
  assert.strictEqual(f.created.length, 1, 'a legacy hold is still re-enterable, and reaches a reviewer');

  // READER 4: the bounce, on a ticket that is held but NOT re-closable.
  const f2 = mkLoop({ repo: mkRepo() });
  f2.tstore.save(f2.team.root, [{
    ...f2.one(), state: 'done', loopStep: 'review',
    verifyHold: { step: 'verify: task-dir', at: old, evidence: 'e' },
  }]);
  f2.injected.length = 0;
  f2.m._handleTask(f2.seat('team-hand'), { type: 'task', sub: 'done', id: 't1', who: null, body: 'r' });
  const bounced = f2.injected.join('\n');
  assert.match(bounced, /is held at/, 'ENTER: it bounced as held');
  assert.ok(!/undefined/.test(bounced), 'and the bounce names a route rather than undefined');
});

// ── t345 r5: a gate on one write, and the fields written beside it ─────────
//
// Review round 2. Both defects are r4's OWN changes reintroducing the class r4
// was fixing — but one level out: the readers that broke are not readers of
// `verifyHold` (which was swept exhaustively) but of `closedAt` and of the
// `recovery` ARGUMENT, two things the r4 gates newly repurposed.
//
// The rule, worth stating where the next reader of this file will find it: a
// gate added to one write must be checked against every field written NEAR it.
// MF1 is a line that used to be fresh because of a line that got guarded; MF2 is
// an argument that used to be inert because of a branch that got added.

test('t345 r5 MF1: a re-entry re-times the stall clock, so the recovered ticket does NOT alarm', async () => {
  // THE HONEST FORM of the subject this replaces. The r2 alarm-wording subject
  // PLANTS `lastActivityAt: old` by hand to force an alarm — so it asserts the
  // body of exactly the alarm that should never have fired, and could never have
  // caught this. Here the age is REAL: it comes from a first close that genuinely
  // happened long ago, and the re-close runs through the real handler.
  //
  // A `spec` or `infra` hold routinely waits longer than the stall window, so
  // this is the ordinary path, not a corner: the hand acts, and 60 seconds later
  // the lead is told the loop has made "no progress for 2h".
  const repo = mkRepo();
  const f = mkLoop({ repo });

  // A real first close, which stamps `closedAt` for real.
  f.m._handleTask(f.seat('team-hand'), { type: 'task', sub: 'done', id: 't1', who: null, body: 'nothing committed yet' });
  for (let i = 0; i < 40 && !f.one().verifyHold; i++) await new Promise((r) => setTimeout(r, 25));
  assert.ok(f.one().verifyHold, 'ENTER: the ticket is held');

  // Age that close past the stall window — the ticket sat waiting for a human,
  // which is what a held ticket DOES.
  const twoHoursAgo = Date.now() - (2 * 60 * 60 * 1000);
  f.tstore.save(f.team.root, [{ ...f.one(), closedAt: twoHoursAgo, lastActivityAt: twoHoursAgo, nudgedAt: null }]);

  // The hand acts. Hold the loop inside the suite so the sweep observes a
  // genuinely-running re-verify rather than a finished one.
  commitOnBranch(repo.dir, 'tl-1', 'work.txt', 'the work\n');
  const release = holdInSuite(f);
  f.m._handleTask(f.seat('team-hand'), { type: 'task', sub: 'done', id: 't1', who: null, body: 'committed it' });
  for (let i = 0; i < 40 && f.one().loopStep !== 'verify'; i++) await new Promise((r) => setTimeout(r, 25));
  await new Promise((r) => setTimeout(r, 50));
  assert.strictEqual(f.one().loopStep, 'verify', 'ENTER: the re-verify is running');
  assert.ok(!('verifyHold' in f.one()), 'ENTER: and the hold was cleared by the re-entry');

  f.gated.length = 0;
  await f.m._sweepTeamTickets(f.team, Date.now());
  const nudges = f.gated.filter((g) => g.sender === 'ticket-watchdog');

  release();
  for (let i = 0; i < 80 && f.created.length === 0; i++) await new Promise((r) => setTimeout(r, 25));

  assert.deepStrictEqual(nudges.map((n) => n.body), [],
    'a loop that started seconds ago must raise NOTHING — the re-entry is a new stall episode and has to re-time `last`, not only clear `nudgedAt`');
  assert.strictEqual(f.created.length, 1, 'ENTER: and the re-verify really did go on to reach a reviewer');
});

test('t345 r5 MF2: a REVIEW-step throw prescribes NO recovery in the escalation body', async () => {
  // MF3's failure mode relocated from the sweep into the escalation. The stamp is
  // correctly skipped, but the escalation still carried `recovery: 'infra'` — so
  // the lead was told to `task done` a ticket that is `done` + `loopStep:'review'`
  // with no stamp, where `reentry` is false and the handler bounces with no held
  // clause and no alternative. Straight back to `reject`.
  //
  // The r4 subject asserted `!/RECOVERY:/` on the SWEEP body, so the escalation
  // body was unpinned — the gap this closes.
  const repo = mkRepo();
  commitOnBranch(repo.dir, 'tl-1', 'work.txt', 'the work\n');
  const f = mkLoop({ repo });
  f.tstore.save(f.team.root, [{ ...f.one(), state: 'done', loopStep: 'verify', report: 'r', reportedBy: 'team-hand' }]);
  f.m._spawnTicketReview = () => { throw new Error('spawn exploded'); };

  await f.m._runTicketLoop(f.team, 't1');
  await new Promise((r) => setImmediate(r));

  const body = f.esc()[0].body;
  assert.match(body, /stopped at: review/, 'ENTER: it is the review-step throw');
  assert.ok(!/RECOVERY:/.test(body),
    'no route may be prescribed here: the ticket has no verifyHold, so the re-entry gate refuses the verb this would name');
  assert.ok(!/could not RUN/.test(body),
    'and the infra sentence is factually wrong here — verify passed and the diff was written');
});

test('t345 r5 MF2: a VERIFY-step throw still DOES carry its recovery', async () => {
  // The other side of the same gate: the catch-all is shared, and narrowing it to
  // silence the review case must not silence the verify case, which is a genuine
  // infra hold with a genuine route.
  const repo = mkRepo();
  const f = mkLoop({ repo });
  f.tstore.save(f.team.root, [{ ...f.one(), state: 'done', loopStep: 'verify', report: 'r', reportedBy: 'team-hand' }]);
  // Throw INSIDE verify, before the record advances to `review`.
  f.m._runTicketSuite = () => { throw new Error('suite exploded'); };
  commitOnBranch(repo.dir, 'tl-1', 'work.txt', 'the work\n');

  await f.m._runTicketLoop(f.team, 't1');
  await new Promise((r) => setImmediate(r));

  const body = f.esc()[0].body;
  assert.match(body, /stopped at: verify/, 'ENTER: the throw is at a verify step');
  assert.match(body, /RECOVERY:/, 'a verify-step throw IS a hold, and keeps its route');
  assert.strictEqual(f.one().verifyHold.recovery, 'infra', 'and is stamped infra');
});

test('t345 r5 nit2: an UNDELIVERABLE rework does not tell the seat "no rework round was counted"', async () => {
  // This arm is reached BECAUSE the reject succeeded and only its delivery
  // failed: the ticket is `open`, `reworkRound` is up, `loopStep` is gone. The
  // hand notice would say the opposite of all three — to a seat that could not be
  // reached anyway — and the stamp would write a `verifyHold` onto an open ticket,
  // a state no reader is written for.
  const repo = mkRepo();
  commitOnBranch(repo.dir, 'tl-1', 'work.txt', 'the work\n');
  const f = mkLoop({ repo, suite: 'red' });
  f.tstore.save(f.team.root, [{ ...f.one(), state: 'done', loopStep: 'verify', report: 'r', reportedBy: 'team-hand' }]);
  // No seat holds the role, so _rejectTicketFromLoop cannot deliver.
  f.m.sessions.delete('team-hand');

  await f.m._runTicketLoop(f.team, 't1');
  await new Promise((r) => setImmediate(r));

  assert.strictEqual(f.esc().length, 1, 'ENTER: the lead was told, which is the whole recovery here');
  assert.match(f.esc()[0].body, /rework could not be sent back/, 'ENTER: and it is THIS arm');
  const t = f.one();
  assert.ok(!('verifyHold' in t), 'no hold is stamped on a ticket the reject already reopened');
  assert.deepStrictEqual(f.gated.filter((g) => /HELD/.test(g.body)), [],
    'and no seat is told the ticket was not rejected when it was');
});

// ── t465: two readers whose wording disagreed with the state ───────────────
//
// Both folded in from t345's round-3 review, and both the same class as the
// recovery text one field over: a consumer of the loop's state describing it in
// words that contradict what the state actually is.

test('t465 nit1: a RE-ENTRY broadcasts "re-verifying", not a second "done"', async () => {
  // The `reply` on this path already says `re-verifying (was held at …)`. The
  // ipc-message broadcast said `done` — so every consumer of that channel saw a
  // second close for a ticket that was never re-closed in the lifecycle sense,
  // while the seat that fired it was correctly told otherwise.
  const repo = mkRepo();
  const f = mkLoop({ repo });

  await strand(f);
  commitOnBranch(repo.dir, 'tl-1', 'work.txt', 'the work\n');
  const release = holdInSuite(f);
  f.broadcasts.length = 0;
  f.m._handleTask(f.seat('team-hand'), { type: 'task', sub: 'done', id: 't1', who: null, body: 'fixed it' });
  // MEASURED, and it is the STAMP that carries the guarantee, not `loopStep`:
  // `strand()` already leaves `loopStep: 'verify'` and the escalation arm keeps
  // it there, so asserting the step fails only if `strand` breaks. Probed either
  // side of the call: `verifyHold` is present BEFORE it and gone after. The
  // original spin loop never iterated; this asserts what it pretended to await,
  // and goes red if the clearing ever moves behind an await.
  assert.ok(!('verifyHold' in f.one()),
    'ENTER: the re-entry cleared the stamp synchronously — there is nothing to await');

  const tasks = f.broadcasts.filter((b) => b.msg && b.msg.type === 'task');
  // ENTER: the re-entry really was taken. Without this the assertions below are
  // all true of an empty list — the false-green shape this suite keeps hitting.
  assert.strictEqual(tasks.length, 1, 'ENTER: exactly one task broadcast came off the re-entry');
  assert.strictEqual(tasks[0].msg.body, 'ticket t1 re-verifying',
    'the broadcast agrees with the reply: nothing closed here, the checks are re-running');
  assert.ok(!/done/.test(tasks[0].msg.body),
    'and it must not read as a close — the ticket was already done before this fired');

  release();
  for (let i = 0; i < 80 && f.created.length === 0; i++) await new Promise((r) => setTimeout(r, 25));
});

test('t465 nit1: an ORDINARY close still broadcasts "done"', async () => {
  // The other half, and the one that catches a fix applied too widely: the
  // re-entry wording must not leak onto the first close, which IS a close.
  const repo = mkRepo();
  commitOnBranch(repo.dir, 'tl-1', 'work.txt', 'the work\n');
  const f = mkLoop({ repo });
  f.broadcasts.length = 0;

  f.m._handleTask(f.seat('team-hand'), { type: 'task', sub: 'done', id: 't1', who: null, body: 'did it' });

  const tasks = f.broadcasts.filter((b) => b.msg && b.msg.type === 'task');
  assert.strictEqual(tasks.length, 1, 'ENTER: the close broadcast fired');
  assert.strictEqual(tasks[0].msg.body, 'ticket t1 done', 'a real close still reads as one');
});

test('t465 nit2: a second `done` during a re-verify says the checks have not reported', async () => {
  // The stamp is cleared when the re-verify starts, so this bounce had no held
  // clause and no explanation — a bare "is done, not open". REFUSING is correct
  // and stays correct: two loops on one branch is what the gate prevents. Only
  // the wording is the defect, and a refusal that explains nothing is
  // historically what sends the reader back to `reject`.
  const repo = mkRepo();
  const f = mkLoop({ repo });

  await strand(f);
  commitOnBranch(repo.dir, 'tl-1', 'work.txt', 'the work\n');
  const release = holdInSuite(f);
  // ENTER: without this the subject passes having never taken the re-entry — if
  // the stamp stops being written, `reentry` is false, the handler bounces down
  // the `state !== 'open'` path, and every assertion below still holds. Measured:
  // removing the stamp at `team-tickets.js:5496` left this subject GREEN while
  // its twin and eight others went red.
  assert.ok(f.one().verifyHold, 'ENTER: the ticket is HELD before the re-entry');
  f.m._handleTask(f.seat('team-hand'), { type: 'task', sub: 'done', id: 't1', who: null, body: 'fixed it' });
  // MEASURED, and it is the STAMP that carries the guarantee, not `loopStep`:
  // `strand()` already leaves `loopStep: 'verify'` and the escalation arm keeps
  // it there, so asserting the step fails only if `strand` breaks. Probed either
  // side of the call: `verifyHold` is present BEFORE it and gone after. The
  // original spin loop never iterated; this asserts what it pretended to await,
  // and goes red if the clearing ever moves behind an await.
  assert.ok(!('verifyHold' in f.one()),
    'ENTER: the re-entry cleared the stamp synchronously — there is nothing to await');
  await new Promise((r) => setTimeout(r, 50));

  const t = f.one();
  // ENTER: the state under test is the one with NO stamp and a running check.
  // Planting it would pass against code that never reaches it.
  assert.strictEqual(t.state, 'done', 'ENTER: still done');
  assert.strictEqual(t.loopStep, 'verify', 'ENTER: still at verify');
  assert.ok(!('verifyHold' in t), 'ENTER: and the stamp is GONE — the checks are running, not held');

  f.injected.length = 0;
  f.m._handleTask(f.seat('team-hand'), { type: 'task', sub: 'done', id: 't1', who: null, body: 'again' });
  const said = f.injected.join('\n');

  assert.match(said, /is done, not open/, 'ENTER: it still refuses, which is the correct behaviour');
  assert.match(said, /checks have not reported yet/, 'and now it says WHY, instead of leaving the reader to guess');
  // HEDGED deliberately. This state does not prove a check is RUNNING — a
  // process that died mid-re-verify leaves the same shape — so a sentence
  // asserting one would send that seat to wait for a result never coming.
  assert.ok(!/running right now/.test(said),
    'it must not assert a live check it cannot observe');
  assert.match(said, /stall alarm/, 'so it names the alarm that does cover the dead-process case');
  assert.ok(!/held at/.test(said), 'it must not claim a hold that is not there — nothing is waiting on a human');
  assert.ok(!/undefined/.test(said), 'never "undefined" from reading the cleared stamp');

  release();
  for (let i = 0; i < 80 && f.created.length === 0; i++) await new Promise((r) => setTimeout(r, 25));
});

test('t465 nit2: a HELD ticket still gets its recovery, not the not-yet-reported wording', async () => {
  // The discriminator. Both states are done-at-verify; only the stamp separates
  // them, and telling a held reader to "wait for the result" would strand it
  // waiting on a loop that has already stopped.
  const repo = mkRepo();
  const f = mkLoop({ repo });

  await strand(f);
  // Re-entry is gated on the stamp's PRESENCE, so a held ticket re-runs rather
  // than bouncing. Reaching the bounce needs the legacy shape the clause is
  // written for: a stamp at a step the re-entry gate does not accept.
  f.tstore.save(f.team.root, [{ ...f.one(), loopStep: 'review' }]);
  f.injected.length = 0;

  f.m._handleTask(f.seat('team-hand'), { type: 'task', sub: 'done', id: 't1', who: null, body: 'again' });
  const said = f.injected.join('\n');

  assert.match(said, /is done, not open/, 'ENTER: this is the bounce');
  assert.match(said, /held at "verify: commits-on-branch"/, 'ENTER: and the held clause was reached');
  assert.ok(!/checks have not reported yet/.test(said),
    'a HELD ticket has reported — the loop stopped and someone owes it an action');
  assert.match(said, /close the ticket again/, 'so it carries the recovery, which is what the stamp is for');
});
