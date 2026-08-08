// Run: node --test
// t240 — the deferred-notice queue and its first producer, "Clodex was
// upgraded".
//
// Three banks and the bridges between them, because t239's two escapes were
// both "tests on both banks of a seam, none on the bridge":
//   1. the pure queue     (notice-queue.js: append, depth cap, age horizon)
//   2. the DRAIN          (the generated notices.sh, run as bash against real
//                          files — the same bytes the packaged app bakes)
//   3. the PRODUCER       (the real create() claude arm, driven end to end, so
//                          the gate under test is the expression that ships and
//                          not a copy of it re-derived in the harness)
//
// THE ENTER QUESTION FOR THIS FILE. Most pins here are about something NOT
// happening — a notice not enqueued at a boundary, a stale one not delivered, a
// second resume not re-announcing. Absence passes for free when the setup never
// reached the window, so each such test separately asserts the precondition that
// puts it inside one.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const { createCliHooks } = require('../cli-hooks');
const { createSessionManager } = require('../session-manager');
const { pathFor, runDirFor } = require('../clodex-paths');
const { promptCacheDir } = require('../ipc-prompt-cache');
const {
  NOTICE_MAX_DEPTH, NOTICE_MAX_AGE_MS,
  noticeDir, noticePath, enqueueNotice, parseNotices, versionNoticeFor, clearNotices,
} = require('../notice-queue');

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'clodex-t240-')); }

function lines(root, name) {
  return fs.readFileSync(noticePath(root, name), 'utf8').split('\n').filter((l) => l.trim());
}

// ------------------------------------------------------------ 1. the queue

test('the queue is at the SHARED root, not under run/<name>/ that every exit rm -rf s', () => {
  const root = tmp();
  assert.strictEqual(noticeDir(root, 'a'), path.join(root, 'notices', 'a'));
  assert.strictEqual(noticePath(root, 'a'), path.join(root, 'notices', 'a', 'queue.jsonl'));
  // The distinction this test exists for: a notice is typically enqueued at the
  // spawn following the exit that deleted run/<name>/, and must survive the next
  // one too. Being merely "somewhere else" is not enough — it must not be under
  // the run dir at all.
  const rd = runDirFor(root, 'a');
  assert.ok(!noticePath(root, 'a').startsWith(rd + path.sep),
    'the queue must not live under the run dir: cleanupClaudeHook rm -rf s it on every exit path, including the one before the resume the notice exists to serve');
});

test('enqueue appends whole records; two producers between submits both land, in order', () => {
  const root = tmp();
  assert.strictEqual(enqueueNotice(root, 'a', 'FIRST', 1000), true);
  assert.strictEqual(enqueueNotice(root, 'a', 'SECOND', 2000), true);

  const recs = lines(root, 'a').map((l) => JSON.parse(l));
  // The whole record, not a field probe: a missing `at` would leave the horizon
  // filter comparing against undefined, which is legal arithmetic yielding NaN
  // and a comparison that is silently always false — i.e. no horizon at all.
  assert.deepStrictEqual(recs, [
    { text: 'FIRST', at: 1000 },
    { text: 'SECOND', at: 2000 },
  ]);
  assert.deepStrictEqual(parseNotices(root, 'a').map((r) => r.text), ['FIRST', 'SECOND']);
});

test('enqueue refuses an empty or whitespace-only notice, and trims what it keeps', () => {
  const root = tmp();
  assert.strictEqual(enqueueNotice(root, 'a', '   ', 1), false);
  assert.strictEqual(enqueueNotice(root, 'a', null, 1), false);
  assert.ok(!fs.existsSync(noticePath(root, 'a')), 'nothing worth saying creates no file at all');
  assert.strictEqual(enqueueNotice(root, 'a', '  padded  ', 1), true);
  assert.deepStrictEqual(parseNotices(root, 'a').map((r) => r.text), ['padded']);
});

test('the depth cap drops the OLDEST, keeping the newest NOTICE_MAX_DEPTH', () => {
  const root = tmp();
  const over = NOTICE_MAX_DEPTH + 5;
  for (let i = 0; i < over; i++) enqueueNotice(root, 'a', `n${i}`, 1000 + i);
  const got = parseNotices(root, 'a').map((r) => r.text);
  assert.strictEqual(got.length, NOTICE_MAX_DEPTH, 'ENTER: the cap must actually have bitten — an under-full queue proves nothing about which end is dropped');
  assert.strictEqual(got[got.length - 1], `n${over - 1}`, 'the newest survives');
  assert.strictEqual(got[0], `n${over - NOTICE_MAX_DEPTH}`,
    'the oldest went: dropping the NEWEST would discard the only entry still describing the world the agent is about to wake into');
  assert.ok(!got.includes('n0'), 'the first notice is gone');
});

test('staleness is NOT enforced at enqueue — an ancient entry is written and kept', () => {
  const root = tmp();
  const now = 1_000_000_000_000;
  enqueueNotice(root, 'a', 'ANCIENT', now - NOTICE_MAX_AGE_MS - 1);
  enqueueNotice(root, 'a', 'FRESH', now - 1000);
  // The queue exists to sit unread until a resume, so at append time nothing is
  // stale and the producer has no business judging. The DROP is the drain's, and
  // is pinned against the real bash script further down — one copy of the rule,
  // in the process that runs it.
  assert.deepStrictEqual(parseNotices(root, 'a').map((r) => r.text), ['ANCIENT', 'FRESH']);
});

test('a corrupt line is skipped, never fatal — one bad append must not cost the notices around it', () => {
  const root = tmp();
  enqueueNotice(root, 'a', 'GOOD ONE', 1);
  fs.appendFileSync(noticePath(root, 'a'), '{ not json\n');
  fs.appendFileSync(noticePath(root, 'a'), `${JSON.stringify({ at: 2 })}\n`); // no text
  enqueueNotice(root, 'a', 'GOOD TWO', 3);
  assert.deepStrictEqual(parseNotices(root, 'a').map((r) => r.text), ['GOOD ONE', 'GOOD TWO']);
});

test('reading a queue that was never written is empty, not a throw', () => {
  const root = tmp();
  assert.deepStrictEqual(parseNotices(root, 'nobody'), []);
});

// ------------------------------------------------- 1b. the version producer

test('versionNoticeFor: a difference yields one factual line naming BOTH versions', () => {
  const n = versionNoticeFor('5.2.0', '5.3.0');
  assert.ok(n, 'ENTER: a genuine version change must produce a notice');
  // Roles, not mere presence: the two versions are symmetric strings, so a
  // notice with them swapped matches any test that only asks whether each
  // appears. Anchor each to the phrase that gives it its meaning.
  assert.match(n, /last running under 5\.2\.0/, 'the recorded baseline is what it WAS on');
  assert.match(n, /host now running it is 5\.3\.0/, 'the running app is what it is on NOW');
  assert.match(n, /^<system-reminder>/);
  assert.match(n, /<\/system-reminder>$/);
});

test('versionNoticeFor: same version, or either side missing, says nothing', () => {
  assert.strictEqual(versionNoticeFor('5.3.0', '5.3.0'), null, 'no upgrade, no notice');
  assert.strictEqual(versionNoticeFor(null, '5.3.0'), null,
    'a record with no baseline (written before this feature) is silent by construction — we cannot name a version we never stored, and a floor would be a lie');
  assert.strictEqual(versionNoticeFor('5.2.0', null), null);
  assert.strictEqual(versionNoticeFor('  ', '5.3.0'), null);
});

test('versionNoticeFor renders NO changelog prose — just the two versions and what they imply', () => {
  const n = versionNoticeFor('5.2.0', '5.3.0');
  // The channel is dumb on purpose (DELTA_HEADER's comment is binding here too):
  // a prose renderer drifts from the bytes it describes, and the changelog is
  // written for people running Clodex, not for a seat auditing its own grammar.
  assert.doesNotMatch(n, /##|Unreleased|CHANGELOG/i,
    'no changelog markup or section names may reach the agent');
});

// ---------------------------------------------------------- 2. the drain

function hooks(root) {
  return createCliHooks({
    REGISTRY_DIR: root,
    memoryStore: { list: () => [] },
    getUiSettings: () => ({ get: () => ({ statusline: { claude: [], claudeCommand: '' } }) }),
    nodeInterp: process.execPath,
  });
}

test('the notice drain is registered under UserPromptSubmit, after ipcdelta, and NOT per-tool', () => {
  const root = tmp();
  hooks(root).setupClaudeHook('agent1');
  const scriptPath = pathFor(root, 'agent1', 'noticeScript');
  const settings = JSON.parse(fs.readFileSync(pathFor(root, 'agent1', 'settings'), 'utf8'));

  const cmds = settings.hooks.UserPromptSubmit[0].hooks.map((h) => h.command);
  const noticeIdx = cmds.indexOf(scriptPath);
  assert.ok(noticeIdx >= 0, 'ENTER: the drain must be registered at all — an indexOf of -1 satisfies "after ipcdelta" for the wrong reason');
  const deltaIdx = cmds.findIndex((c) => c.endsWith('ipcdelta.sh'));
  assert.ok(deltaIdx >= 0, 'ENTER: ipcdelta must be present to be ordered against');
  assert.ok(deltaIdx < noticeIdx,
    'the prompt delta comes first: it can change what the intents below it MEAN, while a notice is a fact about the host');

  const postCmds = settings.hooks.PostToolUse[0].hooks.map((h) => h.command);
  assert.ok(!postCmds.includes(scriptPath),
    'not per-tool: like selection, this is turn-boundary content, and draining it mid-loop would land it between two tool calls');
});

test('the notice drain claims by rename, consumes, and emits one UserPromptSubmit block', () => {
  const root = tmp();
  hooks(root).setupClaudeHook('agent1');
  const scriptPath = pathFor(root, 'agent1', 'noticeScript');

  enqueueNotice(root, 'agent1', 'NOTICE ALPHA');
  enqueueNotice(root, 'agent1', 'NOTICE BETA');

  const out = cp.execFileSync('bash', [scriptPath], { encoding: 'utf-8' });
  const parsed = JSON.parse(out);
  assert.strictEqual(parsed.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  const ctx = parsed.hookSpecificOutput.additionalContext;
  assert.match(ctx, /NOTICE ALPHA/, 'ENTER: the drain ran and delivered');
  assert.match(ctx, /NOTICE BETA/, 'both notices ride one submit');
  assert.ok(ctx.indexOf('NOTICE ALPHA') < ctx.indexOf('NOTICE BETA'), 'in the order queued');

  // AT-MOST-ONCE, and that is the point: consumed on read. (The prompt delta is
  // the other tier and must stay a separate mechanism — a shared drain would
  // silently downgrade it.)
  assert.ok(!fs.existsSync(noticePath(root, 'agent1')), 'the queue file is gone after the drain');
  assert.strictEqual(cp.execFileSync('bash', [scriptPath], { encoding: 'utf-8' }), '',
    'an empty queue produces no output at all');
});

test('the drain claims by RENAME, so a producer appending mid-drain is delivered next turn', () => {
  const root = tmp();
  hooks(root).setupClaudeHook('agent1');
  const body = fs.readFileSync(pathFor(root, 'agent1', 'noticeScript'), 'utf8');
  assert.match(body, /renameSync/,
    'the queue must be claimed by rename, not read in place: a truncate-after-read destroys whatever landed in between');
});

test('the drain drops entries past the horizon and delivers the rest', () => {
  const root = tmp();
  hooks(root).setupClaudeHook('agent1');
  const scriptPath = pathFor(root, 'agent1', 'noticeScript');
  const now = Date.now();
  enqueueNotice(root, 'agent1', 'MONTH OLD', now - NOTICE_MAX_AGE_MS - 60_000);
  enqueueNotice(root, 'agent1', 'STILL RELEVANT', now - 60_000);
  assert.strictEqual(lines(root, 'agent1').length, 2, 'ENTER: both are on disk, so the drop below is the drain\'s doing');

  const ctx = JSON.parse(cp.execFileSync('bash', [scriptPath], { encoding: 'utf-8' }))
    .hookSpecificOutput.additionalContext;
  assert.match(ctx, /STILL RELEVANT/, 'ENTER: the drain delivered');
  assert.doesNotMatch(ctx, /MONTH OLD/,
    'a seat dormant across a fortnight of releases is better told nothing than told about the third-to-last one');
});

// NOT PINNED, deliberately: whether the horizon comparison is `>` or `>=`. The
// drain computes `now` itself, milliseconds after any timestamp a test can
// write, so the exactly-equal case is unreachable from outside — and it is one
// millisecond of a fortnight either way.
test('a queue of ONLY stale entries produces no output, and is still consumed', () => {
  const root = tmp();
  hooks(root).setupClaudeHook('agent1');
  const scriptPath = pathFor(root, 'agent1', 'noticeScript');
  enqueueNotice(root, 'agent1', 'ANCIENT', Date.now() - NOTICE_MAX_AGE_MS - 1);
  assert.strictEqual(lines(root, 'agent1').length, 1, 'ENTER: there is something to drop');
  assert.strictEqual(cp.execFileSync('bash', [scriptPath], { encoding: 'utf-8' }), '',
    'no additionalContext at all rather than an empty block');
  assert.ok(!fs.existsSync(noticePath(root, 'agent1')),
    'still consumed: leaving stale entries behind would re-scan them on every submit forever');
});

test('the drain skips an unparseable line and delivers the rest', () => {
  const root = tmp();
  hooks(root).setupClaudeHook('agent1');
  const scriptPath = pathFor(root, 'agent1', 'noticeScript');
  enqueueNotice(root, 'agent1', 'KEEP ONE');
  fs.appendFileSync(noticePath(root, 'agent1'), '{ not json\n');
  enqueueNotice(root, 'agent1', 'KEEP TWO');
  const ctx = JSON.parse(cp.execFileSync('bash', [scriptPath], { encoding: 'utf-8' }))
    .hookSpecificOutput.additionalContext;
  assert.match(ctx, /KEEP ONE/, 'ENTER: the drain ran and delivered');
  assert.match(ctx, /KEEP TWO/, 'the line after the corrupt one still arrived');
});

test('the drain reads the SHARED root, not the run dir it would outlive', () => {
  const root = tmp();
  hooks(root).setupClaudeHook('shared');
  const body = fs.readFileSync(pathFor(root, 'shared', 'noticeScript'), 'utf8');
  assert.ok(body.includes(noticePath(root, 'shared')),
    'the script must point at notices/<name>/ at the shared root — cleanupClaudeHook rm -rf s run/<name>/ on every exit, so a queue read from there would be empty exactly when it matters');
  assert.ok(!body.includes(path.join(runDirFor(root, 'shared'), 'queue.jsonl')));
});

test('the horizon in the generated script is the module constant, not a second literal', () => {
  const root = tmp();
  hooks(root).setupClaudeHook('agent1');
  const body = fs.readFileSync(pathFor(root, 'agent1', 'noticeScript'), 'utf8');
  // A copy of the number in the template would drift the first time either side
  // is tuned, and the drift is invisible: both values are plausible.
  assert.match(body, new RegExp(`MAX_AGE_MS = ${NOTICE_MAX_AGE_MS}\\b`));
});

// --------------------------------------------------------- 3. the producer

// Drive the REAL create() claude arm. The gate under test is
// `!!resumeId && !mint && hookInstalled` as it SHIPS — an earlier file in this
// repo learned the hard way that recomputing it in the harness pins a copy, and
// reverting the product line left everything green.
function producerHarness({ appVersion, entry = null, resumeId = null, mint = false, extraArgs = [] } = {}) {
  const root = tmp();
  const enqueued = [];
  const cleared = [];
  const upserts = [];
  let record = entry ? { ...entry } : null;
  const SessionManager = createSessionManager({
    REGISTRY_DIR: root,
    fs, path, pathFor,
    promptCacheDir,
    PENDING_DIR: path.join(root, 'pending'),
    appVersion,
    // The real producer decision, with the real notice text. Only the sink is a
    // spy, so what is recorded is what would have hit the queue.
    versionNoticeFor,
    enqueueNotice: (r, n, text) => { enqueued.push({ root: r, name: n, text }); return true; },
    // The boundary clear DELEGATES to the real one rather than being a pure
    // spy: its whole job is that the file is gone afterwards, and a spy that
    // only counts calls would pass just as happily against a clearNotices that
    // removed nothing.
    clearNotices: (r, n) => { cleared.push({ root: r, name: n }); return clearNotices(r, n); },
    bakePrompt: (r, n, realIpc) => realIpc,
    setupClaudeHook: (n) => {
      fs.mkdirSync(runDirFor(root, n), { recursive: true });
      return path.join(root, 'settings.json');
    },
    resolveProxyAgentId: ({ name }) => name,
    resolveTeam: () => null,
    formatTeamBlock: () => '',
    matchSeatRole: () => null,
    resolveSystemPromptFile: () => null,
    readAppendBodies: () => [],
    buildIpcPrompt: () => 'IPC PROTOCOL v1\n[agent:dm TARGET] body\n',
    pluginGrammarLines: () => [],
    mergeClaudeSystemPrompt: (args, ipcPrompt) => ({ cleaned: [...args], append: ipcPrompt }),
    cleanupClaudeHook: () => {},
    cleanupSkillPlugin: () => {},
    ensureDir: (d) => fs.mkdirSync(d, { recursive: true }),
    MSG_DIR: path.join(root, 'messages'),
    runDirFor,
    registry: { register: () => {}, unregister: () => {} },
    Transport: class { constructor() {} start() {} stop() {} },
    JsonlWatcher: class { constructor() {} start() {} stop() {} },
    getAgentLibrary: () => ({ list: () => [] }),
    unionEnabled: () => [],
    buildAgentsArg: () => null,
    writeSkillPlugin: () => null,
    effectiveInjectedSkills: () => [],
    getRemoteServer: () => null,
    getUiSettings: () => ({ get: () => ({}) }),
    // A real round-tripping record: the producer reads the baseline off it and
    // the upsert writes the advance back, so a second spawn sees what the first
    // left. A get()-returns-null stub would make the edge-trigger untestable.
    getPersistence: () => ({
      list: () => (record ? [record] : []),
      get: () => record,
      upsert: (e) => { upserts.push(e); record = { ...(record || {}), ...e }; },
      setSessionId: () => {},
    }),
    memoryStore: { list: () => [] },
    composeDigest: () => null,
    resolveProxyBase: () => null,
    lastTranscriptWrite: () => null,
    pty: { spawn: () => ({ onData() {}, onExit() {}, pid: 999 }) },
    os,
    notifyOS: () => {},
    log: { info: () => {}, warn: () => {}, error: () => {} },
  });
  const m = new SessionManager();
  m._sendToSession = () => {};

  // create() leaves an fs.watch handle alive, which hangs the whole suite.
  const stopWatchers = (name) => {
    const s = m.sessions.get(name);
    if (!s) return;
    try { if (s.sentinel) s.sentinel.stop(); } catch {}
    try { if (s.watcher) s.watcher.stop(); } catch {}
    try { if (s.ctxWatcher) s.ctxWatcher.close(); } catch {}
    clearTimeout(s._bootDrainTimer);
  };

  return {
    m, root, enqueued, cleared, upserts,
    currentRecord: () => record,
    spawn: async (name) => {
      try {
        return await m.create(
          name, 'claude', os.tmpdir(), extraArgs, resumeId, 'ws', null, false, null,
          [], [], [], [], [], null, [], [], null, null, mint,
        );
      } finally {
        stopWatchers(name);
        // _cleanup, not kill(): kill awaits a real process exit that a fake pty
        // never reports, and the map entry it would remove is what makes a
        // SECOND spawn of the same name possible — the edge-trigger test needs
        // two.
        try { m._cleanup(name); } catch {}
      }
    },
  };
}

test('a RESUME under a newer host enqueues exactly one notice naming both versions', async () => {
  const h = producerHarness({
    appVersion: '5.3.0',
    entry: { name: 'seat', type: 'claude', appVersion: '5.2.0', createdAt: 1 },
    resumeId: 'sid-1',
  });
  await h.spawn('seat');
  assert.strictEqual(h.enqueued.length, 1, 'ENTER: the producer must have fired at all');
  assert.strictEqual(h.enqueued[0].name, 'seat');
  assert.strictEqual(h.enqueued[0].root, h.root, 'enqueued against the registry root, not a stray path');
  // The exact bytes, not "both versions appear somewhere": the two arguments are
  // interchangeable at the call site, and a swap renders a fluent, entirely
  // wrong notice telling the seat it was DOWNgraded.
  assert.strictEqual(h.enqueued[0].text, versionNoticeFor('5.2.0', '5.3.0'),
    'the recorded version is the BASELINE and the running one is the host — reversed, this announces an upgrade that runs backwards');
});

test('the spawn ADVANCES the recorded version — a second resume on the same host is silent', async () => {
  const h = producerHarness({
    appVersion: '5.3.0',
    entry: { name: 'seat', type: 'claude', appVersion: '5.2.0', createdAt: 1 },
    resumeId: 'sid-1',
  });
  await h.spawn('seat');
  assert.strictEqual(h.enqueued.length, 1, 'ENTER: the first resume announced the upgrade');
  assert.strictEqual(h.currentRecord().appVersion, '5.3.0',
    'the upsert must record the running version: this is the ADVANCE half of an edge-triggered comparison');

  // Same manager, same record, spawn again — nothing changed underneath it.
  await h.spawn('seat');
  assert.strictEqual(h.enqueued.length, 1,
    'without the advance, every resume of a conversation older than the host would re-announce the same upgrade forever');
});

test('a record with NO version yields no notice, but the spawn seeds one for next time', async () => {
  const h = producerHarness({
    appVersion: '5.3.0',
    entry: { name: 'seat', type: 'claude', createdAt: 1 },  // pre-feature record
    resumeId: 'sid-1',
  });
  await h.spawn('seat');
  assert.deepStrictEqual(h.enqueued, [],
    'we cannot name a version we never stored, and inventing a floor would announce an upgrade we cannot describe');
  assert.strictEqual(h.currentRecord().appVersion, '5.3.0', 'the baseline is seeded, so the NEXT upgrade is real');
});

test('a BOUNDARY (no resumeId) enqueues nothing — the conversation is built against this host', async () => {
  const h = producerHarness({
    appVersion: '5.3.0',
    entry: { name: 'seat', type: 'claude', appVersion: '5.2.0', createdAt: 1 },
    resumeId: null,
  });
  await h.spawn('seat');
  // ENTER: the version difference the gate is suppressing is genuinely there —
  // otherwise this passes because there was nothing to say.
  assert.ok(versionNoticeFor('5.2.0', '5.3.0'), 'ENTER: these two versions do differ');
  assert.deepStrictEqual(h.enqueued, [], 'a fresh conversation is born knowing the host it runs on');
});

test('a MINT enqueues nothing even carrying a resumeId — the adopted record is a stranger\'s', async () => {
  const h = producerHarness({
    appVersion: '5.3.0',
    entry: { name: 'seat', type: 'claude', appVersion: '5.2.0', createdAt: 1 },
    resumeId: 'sid-1',
    mint: true,
  });
  await h.spawn('seat');
  assert.ok(versionNoticeFor('5.2.0', '5.3.0'), 'ENTER: these two versions do differ');
  assert.deepStrictEqual(h.enqueued, [],
    'a mint regenerates the prompt outright, so the dead namesake record says nothing about THIS conversation');
});

// The producer guard above suppresses the WRITE. These two cover the other
// half: what a previous occupant of this name already left on the queue. The
// guard cannot reach it — it is on the producer, the leftover is on the
// consumer — so without a boundary clear the mint is still DELIVERED it.
test('a MINT clears a dead namesake\'s undrained notice — the guard is on the producer, the leftover is on the drain', async () => {
  const h = producerHarness({
    appVersion: '5.3.0',
    entry: { name: 'seat', type: 'claude', appVersion: '5.2.0', createdAt: 1 },
    resumeId: 'sid-1',
    mint: true,
  });
  // The previous occupant enqueued and died before its first submit.
  enqueueNotice(h.root, 'seat', 'left by the dead namesake');
  assert.deepStrictEqual(parseNotices(h.root, 'seat').map((o) => o.text), ['left by the dead namesake'],
    'ENTER: the stale notice is genuinely on the queue — otherwise the absence below is true of a queue that was never written');

  await h.spawn('seat');

  assert.deepStrictEqual(h.cleared, [{ root: h.root, name: 'seat' }],
    'the boundary must clear, exactly as bakePrompt clears its own staging when reuse is false');
  assert.deepStrictEqual(parseNotices(h.root, 'seat'), [],
    'a brand-new conversation must not be handed the previous occupant\'s advisory');
});

test('a RESUME does NOT clear — an undrained notice survives to the submit it was queued for', async () => {
  const h = producerHarness({
    appVersion: '5.3.0',
    entry: { name: 'seat', type: 'claude', appVersion: '5.2.0', createdAt: 1 },
    resumeId: 'sid-1',
  });
  // Queued by an earlier spawn of this same conversation that never got a
  // submit in. The at-most-once contract is about DELIVERY, not about a
  // respawn discarding what was never read.
  enqueueNotice(h.root, 'seat', 'queued by an earlier spawn of this conversation');

  await h.spawn('seat');

  assert.deepStrictEqual(h.cleared, [], 'a resume is not a boundary');
  const texts = parseNotices(h.root, 'seat').map((o) => o.text);
  assert.deepStrictEqual(texts, ['queued by an earlier spawn of this conversation'],
    'the earlier notice must still be there — clearing on every spawn would make the queue deliverable only when a submit beat the next restart');
  // This spawn's OWN notice goes to the sink, not to disk: the harness spies
  // enqueueNotice. Asserted here so the untouched queue above cannot be read
  // as the producer having stayed silent.
  assert.strictEqual(h.enqueued.length, 1, 'and the resume still enqueued its own upgrade notice');
});

test('NO CHANNEL, NO NOTICE: a user --settings session enqueues nothing', async () => {
  const h = producerHarness({
    appVersion: '5.3.0',
    entry: { name: 'seat', type: 'claude', appVersion: '5.2.0', createdAt: 1 },
    resumeId: 'sid-1',
    extraArgs: ['--settings', '/tmp/theirs.json'],
  });
  await h.spawn('seat');
  assert.ok(versionNoticeFor('5.2.0', '5.3.0'), 'ENTER: these two versions do differ');
  assert.deepStrictEqual(h.enqueued, [],
    'their --settings replaces the whole hooks block, so notices.sh was never installed and a queued notice could never be delivered');
});
