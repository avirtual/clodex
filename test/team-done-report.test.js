'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { createSessionManager } = require('../session-manager');
const { createTeamManifest } = require('../team-manifest');
const ticketsMod = require('../tickets-store');
const { intentEnabled } = require('../intent-catalog');
const { projectDirFor } = require('../clodex-paths');
const { mkTmpRoot } = require('./lib/tmp-roots');

function mkHome() {
  const home = mkTmpRoot('clodex-t1920-home-');
  fs.mkdirSync(path.join(home, 'teams'), { recursive: true });
  return home;
}

function writeManifest(home, name, manifest) {
  const dir = path.join(home, 'teams', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'team.json'), JSON.stringify(manifest));
}

const baseManifest = (root, extra = {}) => ({ root, lead: 'lead', roles: { lead: { template: 'fable-lead' } }, ...extra });

test('loadManifest: done defaults to code, report is accepted, any other value is a load error', () => {
  const home = mkHome();
  const root = mkTmpRoot('clodex-t1920-root-');
  writeManifest(home, 'plain', baseManifest(root));
  writeManifest(home, 'rep', baseManifest(mkTmpRoot('clodex-t1920-root-'), { done: 'report' }));
  writeManifest(home, 'bad', baseManifest(mkTmpRoot('clodex-t1920-root-'), { done: 'reviewed' }));
  const tm = createTeamManifest({ fs, clodexHome: home });
  assert.strictEqual(tm.loadManifest('plain').done, 'code');
  assert.strictEqual(tm.loadManifest('rep').done, 'report');
  assert.throws(() => tm.loadManifest('bad'), /team\.json "done" must be one of code \| report/);
});

test('setTeamDone writes report and code and refuses anything else; createTeam takes done', () => {
  const home = mkHome();
  const root = mkTmpRoot('clodex-t1920-root-');
  writeManifest(home, 'shop', baseManifest(root));
  const tm = createTeamManifest({ fs, clodexHome: home });
  assert.strictEqual(tm.setTeamDone('shop', 'report').done, 'report');
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(home, 'teams', 'shop', 'team.json'), 'utf8')).done, 'report');
  assert.throws(() => tm.setTeamDone('shop', 'merge'), /done must be one of code \| report/);
  assert.strictEqual(tm.loadManifest('shop').done, 'report', 'a refused write leaves the stored value');
  assert.strictEqual(tm.setTeamDone('shop', 'code').done, 'code');
  const made = tm.createTeam({ name: 'mods', root: mkTmpRoot('clodex-t1920-root-'), lead: 'mods-lead', done: 'report' });
  assert.strictEqual(made.done, 'report');
  assert.throws(() => tm.createTeam({ name: 'mods2', root: mkTmpRoot('clodex-t1920-root-'), lead: 'mods2-lead', done: 'x' }),
    /team "mods2" done must be one of code \| report/);
});

function mkFixture({ done = 'report' } = {}) {
  const home = mkHome();
  const root = mkTmpRoot('clodex-t1920-root-');
  const tstore = ticketsMod.createTicketsStore({ clodexHome: home });
  const team = {
    name: 'team', root, lead: 'lead', watchdogMs: null, file: path.join(home, 'teams', 'team', 'team.json'),
    roles: { lead: { brief: 'the lead', dispatch: 'standing' }, hand: { brief: 'the hand', dispatch: 'standing' } },
    trunk: 'master', done,
  };
  const gitCalls = [];
  const gitWorktree = new Proxy({}, { get: (_, k) => (...a) => { gitCalls.push(k); return Promise.resolve({ ok: false, error: 'stub' }); } });
  const records = new Map();
  const persistence = { list: () => [], get: (n) => records.get(n) || null, upsert: () => {}, remove: () => {}, setWorktree: () => {} };
  const deps = {
    knownSkillNames: () => [],
    getRemoteServer: () => null,
    getUiSettings: () => ({ get: () => ({}) }),
    getPersistence: () => persistence,
    getTemplates: () => ({ list: () => [] }),
    notifyOS: () => {},
    intentEnabled,
    withoutPrivilegedIntentsFor: require('../intent-registry').withoutPrivilegedIntentsFor,
    fencedLines: require('../intent-scanner').fencedLines,
    bodyModeFor: require('../intent-registry').bodyModeFor,
    intentEnabledFor: require('../intent-registry').intentEnabledFor,
    intentEnabledForSeat: require('../intent-registry').intentEnabledForSeat,
    pluginRowFor: require('../intent-registry').pluginRowFor,
    validIntentNames: require('../intent-registry').validIntentNames,
    fs,
    path,
    os: require('node:os'),
    ensureDir: (d) => fs.mkdirSync(d, { recursive: true }),
    countPending: require('../pending-store').countPending,
    isDraftOpen: require('../proxy-util').isDraftOpen,
    drainPending: require('../pending-store').drainPending,
    hasActivePending: require('../pending-store').hasActivePending,
    spillToFile: () => '/tmp/spill-stub.txt',
    MSG_MAX_AGE: 1800,
    termAvailableFor: require('../drawer-avail').termAvailableFor,
    REGISTRY_DIR: home,
    AGENT_NAME_RE: /^[a-zA-Z0-9._-]{1,64}$/,
    log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    resolveTeam: (cwd) => (cwd && cwd.startsWith(root) ? team : null),
    findProjectRoot: (cwd) => (cwd && cwd.startsWith(root) ? root : null),
    teamsDir: path.join(home, 'teams'),
    refreshAppMenu: () => {},
    gitWorktree,
    setTeamDone: (name, mode) => { team.done = mode; return team; },
  };
  const SessionManager = createSessionManager(deps);
  const m = new SessionManager();
  const injected = [];
  const reviews = [];
  const escalations = [];
  const suiteRuns = [];
  const merges = [];
  const closeOuts = [];
  m._injectText = (s, text) => { injected.push(text); };
  m._broadcast = () => {};
  m._sendToSession = () => {};
  m._gatedDeliver = () => ({});
  m._writeTicketCost = () => {};
  m._runTicketSuite = async (...a) => { suiteRuns.push(a); return { ran: false, error: 'stub' }; };
  m._handleTeamReview = (session, scope, opts) => { reviews.push({ scope, opts }); };
  m._escalateTicket = (t, id, step, evidence) => { escalations.push({ id, step, evidence }); };
  m._queueAutoMerge = (...a) => { merges.push(a); };
  const realCloseOut = m._closeOutBranchless.bind(m);
  m._closeOutBranchless = (...a) => { closeOuts.push(a[1].id); return realCloseOut(...a); };
  const seat = (name) => {
    if (!m.sessions.has(name)) m.sessions.set(name, { name, type: 'claude', agentType: 'claude', cwd: root, pty: { pid: 1 }, activityState: 'idle' });
    return m.sessions.get(name);
  };
  const lead = seat('lead');
  const add = (body) => m._handleTask(lead, { type: 'task', sub: 'add', who: null, id: null, body });
  const doneBy = (id, report) => m._handleTask(lead, { type: 'task', sub: 'done', who: null, id, body: report });
  const one = (id) => tstore.load(root).find((t) => t.id === id);
  const projectDir = projectDirFor(home, root);
  const settle = () => new Promise((r) => setImmediate(r));
  return { m, team, root, home, tstore, records, lead, add, doneBy, one, projectDir, settle, injected, reviews, escalations, suiteRuns, merges, closeOuts, gitCalls };
}

async function loopSettled(f, id) {
  for (let i = 0; i < 50; i++) {
    await f.settle();
    const t = f.one(id);
    if (t && (t.loopStep !== 'verify' || t.verifyHold)) return;
  }
}

test('[agent:team done]: the lead sets report, a non-lead is refused, bare shows the effective value', () => {
  const f = mkFixture({ done: 'code' });
  f.m._handleTeam(f.lead, { type: 'team', sub: 'done', mode: null, body: '' });
  assert.match(f.injected.pop(), /^\[agent:team\] done of team: code — a ticket closes through its branch/);
  f.m._handleTeam(f.lead, { type: 'team', sub: 'done', mode: 'report', body: '' });
  assert.match(f.injected.pop(), /^\[agent:team\] done of team set to report — .*open tickets keep the policy they were filed under$/);
  assert.strictEqual(f.team.done, 'report');
  const hand = { name: 'team-hand', type: 'claude', agentType: 'claude', cwd: f.root, pty: { pid: 2 } };
  f.m.sessions.set('team-hand', hand);
  f.m._handleTeam(hand, { type: 'team', sub: 'done', mode: 'code', body: '' });
  assert.match(f.injected.pop(), /error: only the team lead \(lead\) can edit team metadata/);
  assert.strictEqual(f.team.done, 'report', 'the refused hand changed nothing');
  f.m._handleTeam(f.lead, { type: 'team', sub: 'done', mode: 'merge', body: '' });
  assert.match(f.injected.pop(), /error: done must be code or report, not "merge"/);
});

test('_taskAdd stamps the team policy on the ticket, respec keeps it, and task list marks report rows', () => {
  const f = mkFixture({ done: 'report' });
  f.add('write the moderation report\ntasks/mod-1/SPEC.md');
  assert.strictEqual(f.one('t1').done, 'report');
  f.team.done = 'code';
  f.add('a code ticket');
  assert.strictEqual(f.one('t2').done, 'code');
  f.m._handleTask(f.lead, { type: 'task', sub: 'respec', who: null, id: 't1', body: 'rewritten spec\ntasks/mod-1/SPEC.md' });
  assert.strictEqual(f.one('t1').done, 'report', 'respec under a code team keeps the stamp from open');
  f.injected.length = 0;
  f.m._handleTask(f.lead, { type: 'task', sub: 'list', who: null, id: null, body: '' });
  const listing = f.injected.join('\n');
  assert.match(listing, /t1 \[open\] \[report\] /);
  assert.match(listing, /t2 \[open\] (?!\[report\])/);
});

test('a team done flip after open does not move an open ticket: the code ticket still takes the code close', async () => {
  const f = mkFixture({ done: 'code' });
  f.add('a code ticket\ntasks/c-1/SPEC.md');
  f.team.done = 'report';
  f.injected.length = 0;
  f.doneBy('t1', 'did it');
  await f.settle();
  assert.ok(f.injected.some((l) => /closed WITHOUT review: the ticket records no branch/.test(l)), 'ENTER: the code steps ran');
  assert.strictEqual(f.reviews.length, 0);
  assert.strictEqual(f.one('t1').artifact, undefined);
});

test('_snapshotArtifacts: a branchless report ticket enters verify: no suite, no git, reviewer scoped to the artifact dir and digest', async () => {
  const f = mkFixture();
  f.add('write the moderation report\ntasks/mod-1/SPEC.md');
  const dir = path.join(f.projectDir, 'tasks', 'mod-1');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'findings.md'), 'three players flagged\n');
  f.doneBy('t1', 'report: see findings.md');
  await loopSettled(f, 't1');
  assert.strictEqual(f.suiteRuns.length, 0, 'no suite runner spawned');
  assert.deepStrictEqual(f.gitCalls, [], 'no git step ran');
  assert.strictEqual(f.reviews.length, 1, 'one reviewer spawned');
  const t = f.one('t1');
  assert.strictEqual(fs.readFileSync(path.join(dir, 'REPORT-t1-r1.md'), 'utf8'), 'report: see findings.md\n');
  const hash = (s) => crypto.createHash('sha256').update(s).digest('hex');
  const pairs = [['REPORT-t1-r1.md', hash('report: see findings.md\n')], ['findings.md', hash('three players flagged\n')]];
  const digest = hash(pairs.map(([p, h]) => `${p}\0${h}\n`).join(''));
  assert.deepStrictEqual(t.artifact, { dir, round: 1, files: 2, digest });
  const snap = JSON.parse(fs.readFileSync(path.join(dir, '.artifact-r1.json'), 'utf8'));
  assert.strictEqual(snap.digest, digest);
  const { scope, opts } = f.reviews[0];
  assert.ok(scope.includes(`ARTIFACT: this ticket closes on its artifacts, not a branch`));
  assert.ok(scope.includes(`under ${dir}`));
  assert.ok(scope.includes(`binds to snapshot ${digest} (round 1)`));
  assert.ok(scope.includes(`  findings.md  22 bytes  sha256 ${hash('three players flagged\n')}`));
  assert.ok(!scope.includes('SUITE: the loop RAN'), 'no suite claim in a report review');
  assert.deepStrictEqual(opts.addDirs, [dir]);
  assert.deepStrictEqual(opts.attach, []);
  assert.strictEqual(t.loopStep, 'review');
});

test('an empty artifact set holds the ticket at verify: artifact and closes nothing', async () => {
  const f = mkFixture();
  f.add('write the moderation report\ntasks/mod-2/SPEC.md');
  const rows = f.tstore.load(f.root);
  rows[0].state = 'done';
  rows[0].loopStep = 'verify';
  rows[0].report = '';
  f.tstore.save(f.root, rows);
  await f.m._runTicketLoop(f.team, 't1');
  const t = f.one('t1');
  assert.strictEqual(t.verifyHold && t.verifyHold.step, 'verify: artifact');
  assert.strictEqual(t.verifyHold.recovery, 'hand', t.verifyHold.evidence);
  assert.match(t.verifyHold.evidence, /^no artifact to review: .*mod-2 holds no file and the report text is blank$/);
  assert.strictEqual(f.reviews.length, 0);
  assert.strictEqual(t.acceptedAt, undefined);
  assert.strictEqual(t.closedOut, undefined);
});

test('no taskDir: the report text becomes the artifact under the project tasks/<id>/ dir and the ticket proceeds', async () => {
  const f = mkFixture();
  f.add('moderate the lobby tonight');
  assert.strictEqual(f.one('t1').taskDir, undefined, 'ENTER: the spec names no tasks/ pointer');
  f.doneBy('t1', 'lobby was quiet');
  await loopSettled(f, 't1');
  const dir = path.join(f.projectDir, 'tasks', 't1');
  assert.strictEqual(fs.readFileSync(path.join(dir, 'REPORT-t1-r1.md'), 'utf8'), 'lobby was quiet\n');
  const t = f.one('t1');
  assert.strictEqual(t.verifyHold, undefined);
  assert.strictEqual(t.artifact.dir, dir);
  assert.strictEqual(t.artifact.files, 1);
  assert.strictEqual(f.reviews.length, 1);
});

function setReviewerRecord(f, name, rec) {
  f.records.set(name, rec);
}

async function acceptFixture() {
  const f = mkFixture();
  f.add('write the moderation report\ntasks/mod-3/SPEC.md');
  const dir = path.join(f.projectDir, 'tasks', 'mod-3');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'findings.md'), 'v1\n');
  f.doneBy('t1', 'see findings');
  await loopSettled(f, 't1');
  assert.strictEqual(f.one('t1').loopStep, 'review', 'ENTER: the reviewer was spawned');
  const name = 'team-reviewer-1-r1';
  f.m.sessions.set(name, { name, type: 'claude', agentType: 'claude', cwd: f.root, pty: { pid: 3 } });
  f.m.kill = () => {};
  f.m._writeReviewCost = () => ({ ok: true });
  f.m._notifyLeadOfVerdict = () => {};
  return { f, dir, reviewer: f.m.sessions.get(name) };
}

test('_landArtifactAccept: ACCEPT with an unchanged digest closes out branchless: nothing merged, accept stamped with the digest', async () => {
  const { f, reviewer } = await acceptFixture();
  const digest = f.one('t1').artifact.digest;
  setReviewerRecord(f, reviewer.name, { ephemeral: true, reviewFor: 'lead', reviewTicket: 't1' });
  f.m._handleReviewDone(reviewer, '- **VERDICT**: ACCEPT\n- **MUST-FIX**: (none)');
  for (let i = 0; i < 20; i++) await f.settle();
  assert.deepStrictEqual(f.merges, [], '_queueAutoMerge not called');
  assert.deepStrictEqual(f.closeOuts, ['t1']);
  const t = f.one('t1');
  assert.strictEqual(t.closedOut, true);
  assert.ok(t.acceptedAt);
  assert.strictEqual(t.acceptNote, `artifact ${digest.slice(0, 8)} reviewed`);
  assert.strictEqual(t.mergedAt, undefined);
});

test('_landArtifactAccept: ACCEPT after the artifact changed holds at verify: artifact naming both digests, nothing closed', async () => {
  const { f, dir, reviewer } = await acceptFixture();
  const was = f.one('t1').artifact.digest;
  fs.writeFileSync(path.join(dir, 'findings.md'), 'v2 — edited under review\n');
  setReviewerRecord(f, reviewer.name, { ephemeral: true, reviewFor: 'lead', reviewTicket: 't1' });
  f.m._handleReviewDone(reviewer, '- **VERDICT**: ACCEPT\n- **MUST-FIX**: (none)');
  for (let i = 0; i < 20; i++) await f.settle();
  assert.deepStrictEqual(f.merges, []);
  assert.deepStrictEqual(f.closeOuts, []);
  const t = f.one('t1');
  assert.strictEqual(t.verifyHold && t.verifyHold.step, 'verify: artifact');
  const now = t.verifyHold.evidence.match(/→ ([0-9a-f]{8})\)/);
  assert.ok(now, t.verifyHold.evidence);
  assert.strictEqual(t.verifyHold.evidence,
    `artifact changed during review (${was.slice(0, 8)} → ${now[1]}) — task done again to re-review`);
  assert.notStrictEqual(now[1], was.slice(0, 8));
  assert.strictEqual(t.loopStep, 'verify', 'held where a task done re-enters it');
  assert.strictEqual(t.closedOut, undefined);
  assert.strictEqual(t.acceptedAt, undefined);
});

test('_artifactScope: a held ticket re-entered by task done gets a round-2 scope naming what changed, not settled ground', async () => {
  const { f, dir, reviewer } = await acceptFixture();
  fs.writeFileSync(path.join(dir, 'findings.md'), 'v2 — edited under review\n');
  setReviewerRecord(f, reviewer.name, { ephemeral: true, reviewFor: 'lead', reviewTicket: 't1' });
  f.m._handleReviewDone(reviewer, '- **VERDICT**: ACCEPT\n- **MUST-FIX**: (none)');
  for (let i = 0; i < 20; i++) await f.settle();
  assert.strictEqual(f.one('t1').verifyHold.step, 'verify: artifact', 'ENTER: held after the changed ACCEPT');
  f.doneBy('t1', 'see findings, v2');
  await loopSettled(f, 't1');
  assert.strictEqual(f.reviews.length, 2, 'the re-entry spawned a second reviewer');
  const t = f.one('t1');
  assert.strictEqual(t.artifact.round, 2);
  const { scope } = f.reviews[1];
  assert.ok(scope.includes("CHANGED since round 1's snapshot:\n  added  REPORT-t1-r2.md\n  modified  findings.md\n"), scope);
  assert.ok(scope.includes("THIS IS ROUND 2. The artifact set changed after round 1's snapshot; review every changed file in full"));
  assert.ok(!scope.includes('sent it back anyway'));
  assert.ok(!scope.includes('already passed'), 'no already-passed framing on an artifact round');
  assert.ok(!scope.includes('Do not re-open'));
});

test('_artifactScope: a REWORK round renders the must-fix verbatim under the artifact framing', () => {
  const { buildReviewScope } = require('../ticket-review-scope');
  const scope = buildReviewScope({
    ticket: { id: 't9', reviewRound: 1, verdict: 'REWORK', mustFix: '1. findings.md names no player' },
    taskDir: '/d',
    artifact: { dir: '/d', round: 2, digest: 'abc', count: 1, files: [{ path: 'findings.md', bytes: 3, sha256: 'ff' }], changed: [] },
  });
  assert.ok(scope.includes("CHANGED since round 1's snapshot: nothing\n"));
  assert.ok(scope.includes('The MUST-FIX items on record from round 1 were, verbatim — check each is fixed:\n\n1. findings.md names no player\n'));
  assert.ok(!scope.includes('Do not re-open'));
});

test('_ticketDispatchMode: a report ticket on a worktree role dispatches as a spawn, a code ticket keeps its tree', () => {
  const f = mkFixture();
  const team = { ...f.team, roles: { ...f.team.roles, hand: { brief: 'h', dispatch: 'worktree' } } };
  assert.strictEqual(f.m._ticketDispatchMode(team, 'hand', { done: 'report' }).mode, 'spawn');
  assert.strictEqual(f.m._ticketDispatchMode(team, 'hand', { done: 'code' }).mode, 'worktree');
  assert.strictEqual(f.m._ticketDispatchMode(team, 'hand', {}).mode, 'worktree', 'a legacy row reads as code');
  assert.strictEqual(f.m._ticketDispatchMode(team, 'hand').mode, 'worktree');
});

test('_writeVerdictBody: a no-taskDir report ticket keeps its verdict file in the artifact dir', async () => {
  const f = mkFixture();
  f.add('moderate the lobby tonight');
  f.doneBy('t1', 'lobby was quiet');
  await loopSettled(f, 't1');
  assert.strictEqual(f.one('t1').loopStep, 'review', 'ENTER: under review');
  const name = 'team-reviewer-1-r1';
  f.m.sessions.set(name, { name, type: 'claude', agentType: 'claude', cwd: f.root, pty: { pid: 3 } });
  f.m.kill = () => {};
  f.m._writeReviewCost = () => ({ ok: true });
  f.m._notifyLeadOfVerdict = () => {};
  setReviewerRecord(f, name, { ephemeral: true, reviewFor: 'lead', reviewTicket: 't1' });
  f.m._handleReviewDone(f.m.sessions.get(name), '- **VERDICT**: ACCEPT\n- **MUST-FIX**: (none)');
  for (let i = 0; i < 20; i++) await f.settle();
  const dir = path.join(f.projectDir, 'tasks', 't1');
  assert.ok(fs.existsSync(path.join(dir, 'review-t1-r1.verdict.md')));
  assert.strictEqual(f.one('t1').closedOut, true, 'the verdict file did not count as an artifact change');
});
