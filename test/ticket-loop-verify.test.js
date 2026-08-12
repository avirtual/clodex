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

function mkLoop({ repo, ticketOver = {}, noLeadSession = false, noReviewerPrompt = false } = {}) {
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
