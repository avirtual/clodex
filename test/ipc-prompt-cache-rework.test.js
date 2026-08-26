// Run: node --test
// t63 — the three seams t61 shipped untested. Cold review found all three by
// reading; none of them had a pin, which is why they shipped. Each one is a way
// the FREEZE outlives the channel that repairs it, so the agent ends up holding
// a stale prompt with no mechanism that will ever correct it — strictly worse
// than the rewrite the freeze exists to avoid.
//
//   MF3  restart routes through kill() → _userKilled, so the gated rm in
//        _cleanup deleted promptcache/ on an ORDINARY restart. The create()
//        that followed carried a non-null resumeId into an empty cache: a full
//        prompt rewrite under a --resume'd conversation, i.e. the original
//        111k-139k bust, on the button labelled "restart".
//   MF2  a user --settings in extraArgs replaces the whole hooks block, so
//        ipcdelta.sh is never installed — the bake froze anyway, with no
//        channel that could ever deliver the diff.
//   MF1  a delivered delta rides UserPromptSubmit additionalContext, which is
//        ordinary conversation content: /clear drops it, /compact summarizes it
//        away. notified.md stayed advanced past it either way.
//
// THE ENTER QUESTION FOR THIS FILE. Every pin here is about a branch NOT taken
// (the rm that must not run, the freeze that must not happen, the reset that
// must not fire on a plain resume). A test that never reaches the branch passes
// for free. So each test asserts the precondition that puts it INSIDE the window
// — the flag is set, the cache exists, the script contains the code being
// ordered — separately from the behaviour it pins, and says so in the message.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createCliHooks } = require('../cli-hooks');
const { createSessionManager } = require('../session-manager');
const { pathFor, runDirFor } = require('../clodex-paths');
const { bakePrompt, promptCacheDir, cachePathFor, readCache } = require('../ipc-prompt-cache');
const { mkTmpRoot } = require('./lib/tmp-roots');

function tmp() { return mkTmpRoot('clodex-t63-'); }

function promptV(extra = '') {
  const lines = [];
  for (let i = 0; i < 120; i++) lines.push(`grammar line ${i}: [agent:verb${i}] does thing ${i}`);
  return `HOW TO COMMUNICATE:\n${lines.join('\n')}\n${extra}RULES:\n- an intent must start on its own line.\n`;
}

function hooks(root) {
  return createCliHooks({
    REGISTRY_DIR: root,
    memoryStore: { list: () => [] },
    getUiSettings: () => ({ get: () => ({ statusline: { claude: [], claudeCommand: '' } }) }),
    nodeInterp: process.execPath,
  });
}

// The cache side, driven directly: `reuse` in, baked bytes out. Used for the
// CACHE behaviour (what freezing and regenerating do). It deliberately does NOT
// decide reuse — that decision lives in session-manager and is pinned separately
// by driving the real create() below.
function bakeAs(root, name, realIpc, { reuse = false } = {}) {
  return bakePrompt(root, name, realIpc, reuse);
}

// The DECISION side. An earlier draft of this file recomputed
// `!!resumeId && !mint && hookInstalled` here in the harness and asserted the
// result — which pinned a copy of the expression, not the expression: reverting
// the product line left every test green. Proven, not assumed (revert B).
//
// So drive the REAL create() claude arm with a spy in bakePrompt's place and
// capture the `reuse` argument session-manager actually computes. A fake pty is
// enough; nothing spawns.
function reuseArgFor({ resumeId = null, mint = false, extraArgs = [] } = {}) {
  const root = tmp();
  const seen = [];
  const SessionManager = createSessionManager({
    REGISTRY_DIR: root,
    fs, path, pathFor,
    promptCacheDir,
    PENDING_DIR: path.join(root, 'pending'),
    bakePrompt: (r, n, realIpc, reuse) => { seen.push(reuse); return realIpc; },
    // The real one creates run/<name>/ as a side effect, and the bake writes
    // append-prompt.md into it — so the stub has to make the dir or create()
    // dies on ENOENT before reaching the decision under test.
    setupClaudeHook: (n) => {
      fs.mkdirSync(runDirFor(root, n), { recursive: true });
      return path.join(root, 'settings.json');
    },
    // The rest of the claude arm's seams. Real leaves where the behaviour is
    // irrelevant to the decision under test, inert stubs where they would reach
    // for a library/proxy/team this test has none of.
    resolveProxyAgentId: ({ name }) => name,
    resolveTeam: () => null,
    formatTeamBlock: () => '',
    matchSeatRole: () => null,
    resolveSystemPromptFile: () => null,
    readAppendBodies: () => [],
    buildIpcPrompt: () => 'IPC PROTOCOL v1\n[agent:dm TARGET] body\n',
    pluginGrammarLines: () => [],
    mergeClaudeSystemPrompt: (extraArgs, ipcPrompt) => ({ cleaned: [...extraArgs], append: ipcPrompt }),
    cleanupClaudeHook: () => {},
    cleanupSkillPlugin: () => {}, cleanupAgentPlugin: () => {},
    ensureDir: (d) => fs.mkdirSync(d, { recursive: true }),
    MSG_DIR: path.join(root, 'messages'),
    runDirFor,
    registry: { register: () => {}, unregister: () => {} },
    Transport: class { constructor() {} start() {} stop() {} },
    JsonlWatcher: class { constructor() {} start() {} stop() {} },
    getAgentLibrary: () => ({ list: () => [] }),
    unionEnabled: () => [],
    writeAgentPlugin: () => null, effectiveInjectedAgents: () => [],
    writeSkillPlugin: () => null,
    effectiveInjectedSkills: () => [],
    getRemoteServer: () => null,
    getUiSettings: () => ({ get: () => ({}) }),
    getPersistence: () => ({ list: () => [], get: () => null, upsert: () => {}, setSessionId: () => {} }),
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

  // A real create() leaves watchers running, and an fs.watch handle
  // (session.ctxWatcher, :1618) keeps the event loop alive forever. Left in
  // place the file reports every test as passing and then HANGS — which inside
  // the full suite is indistinguishable from a deadlock and would wedge CI.
  // Measured, not guessed: an active-resources probe after one spawn reported
  // ["PipeWrap","FSEventWrap","PipeWrap"]. So tear the session down in a
  // finally. The decision under test is made long before any of this, so
  // stopping costs the assertions nothing.
  const stopWatchers = (name) => {
    const s = m.sessions.get(name);
    if (!s) return;
    try { if (s.sentinel) s.sentinel.stop(); } catch {}
    try { if (s.watcher) s.watcher.stop(); } catch {}
    try { if (s.ctxWatcher) s.ctxWatcher.close(); } catch {}
    clearTimeout(s._bootDrainTimer);
  };

  return { m, seen, root, spawn: async (name) => {
    try {
      return await m.create(
        name, 'claude', os.tmpdir(), extraArgs, resumeId, 'ws', null, false, null,
        [], [], [], [], [], null, [], [], null, null, mint,
      );
    } finally { stopWatchers(name); }
  } };
}

// Ask what session-manager decided, asserting the seam was reached at all.
async function decidedReuse(opts, why) {
  const { seen, spawn } = reuseArgFor(opts);
  await spawn('decide-probe');
  assert.strictEqual(seen.length, 1,
    `ENTER: create() must actually reach bakePrompt for ${why} — zero calls means the assertion below is about a decision that was never made`);
  return seen[0];
}

// ------------------------------------------------------- MF3: _cleanup

// Drive the REAL _cleanup. A hand-written "does the rm happen" check would pin
// my reading of the source; this runs the method that shipped the bug.
function mkManager(root) {
  const SessionManager = createSessionManager({
    REGISTRY_DIR: root,
    fs, path,
    pathFor,
    promptCacheDir,
    PENDING_DIR: path.join(root, 'pending'),
    getRemoteServer: () => null,
    getUiSettings: () => ({ get: () => ({}) }),
    getPersistence: () => ({ list: () => [], get: () => null, upsert: () => {}, remove: () => {} }),
    notifyOS: () => {},
    log: { info: () => {}, warn: () => {}, error: () => {} },
    registry: { unregister: () => {} },
    cleanupClaudeHook: (name) => fs.rmSync(runDirFor(root, name), { recursive: true, force: true }),
    cleanupSkillPlugin: () => {}, cleanupAgentPlugin: () => {},
  });
  return new SessionManager();
}

// Put a session in the map with a live cache, run _cleanup with the given flags,
// and report whether the frozen prompt survived.
function cleanupWith(root, name, flags) {
  const m = mkManager(root);
  bakeAs(root, name, promptV(), { reuse: false });
  assert.ok(fs.existsSync(cachePathFor(root, name, 'session')),
    `ENTER: ${name} must have a cached session.md BEFORE _cleanup runs — asserting that a cache "survived" when it was never written passes without testing anything`);
  m.sessions.set(name, { name, agentType: 'claude', ...flags });
  m._cleanup(name);
  return fs.existsSync(cachePathFor(root, name, 'session'));
}

test('MF3: a RESTART keeps the frozen prompt — restart routes through kill(), so _userKilled is NOT "gone for good"', () => {
  const root = tmp();
  // _userKilled true is exactly the restart state: engine.restartSession and
  // applySessionArgs({restart:true}) both call manager.kill(), which sets it
  // (session-manager's own onExit comment has said so since long before t61).
  const survived = cleanupWith(root, 'restarted', { _userKilled: true });
  assert.strictEqual(survived, true,
    'the frozen prompt must survive _cleanup even with _userKilled set: restart routes through kill() too, so gating the rm on that flag deleted the cache on an ordinary restart and the create() that followed rewrote the whole prompt under a --resume\'d conversation — the exact 111k-139k bust this module exists to prevent');
});

test('MF3: a natural exit and an app quit keep it too — the cache outlives every exit path', () => {
  const root = tmp();
  assert.strictEqual(cleanupWith(root, 'natural', {}), true,
    'a natural exit must keep the cache — the next launch resumes this conversation');
  assert.strictEqual(cleanupWith(root, 'quit', { _shuttingDown: true }), true,
    'an app quit must keep the cache — every session is about to be restored with --resume');
});

test('MF3 positive path: archive → unarchive → resume keeps its cache', () => {
  const root = tmp(), name = 'archived';
  // archive() deliberately does NOT set _userKilled (that is what distinguishes
  // it from kill(): the record is kept, stamped archivedAt, to be resumed later).
  // This is the path the whole feature most exists for — a seat parked for days
  // and brought back — so pin it positively rather than inferring it from MF3.
  const survived = cleanupWith(root, name, { _archived: true });
  assert.strictEqual(survived, true,
    'an archived session must keep its frozen prompt: unarchive re-spawns with --resume onto the SAME conversation, and this is the longest-lived case the feature serves');

  // And the resume that follows must actually reuse it, not just find it.
  const born = readCache(root, name, 'session');
  const resumed = bakeAs(root, name, promptV('[agent:newverb] added while archived\n'), { reuse: true });
  assert.strictEqual(resumed, born,
    'and the unarchive must re-bake the bytes the conversation was born with, staging the change as a delta instead of rewriting the prompt');
  assert.ok(fs.existsSync(cachePathFor(root, name, 'delta')),
    'with the change staged for the drain — a freeze that swallows the change silently is the other half of the bug');
});

test('MF3: a MINT does not reuse, even carrying a resumeId (the "adopt" case)', async () => {
  // The stale-baseline hazard the removed rm was aimed at: a name reused for a
  // NEW session. It is handled at the read end instead — the mint front door
  // does not reuse — which is why dropping the rm does not reintroduce it.
  assert.strictEqual(await decidedReuse({ resumeId: 'adopted-sid', mint: true }, 'an adopt-mint'), false,
    'an adopt-mint carries a resumeId but is still a MINT (the mint-vs-restore axis, NOT resumeId) — reusing here would bake the previous occupant\'s frozen bytes into a new session, handing it a stranger\'s prompt');
});

test('MF3: a RESTORE with a resumeId DOES reuse — mint is the axis, not resumeId', async () => {
  assert.strictEqual(await decidedReuse({ resumeId: 'sess-1', mint: false }, 'a restore'), true,
    'the restore path must freeze — this is the control: if the decision were false for everyone, the mint test above would pass against a freeze that never happens at all');
});

test('MF3: the cache side actually reuses when told to, and reseeds when not', () => {
  // The decision above is one half; this is what the two decisions DO. Split
  // deliberately — an earlier draft asserted a locally recomputed predicate and
  // so pinned neither (revert B passed against it).
  const root = tmp(), name = 'recycled';
  const dead = promptV('[agent:deadverb] from the previous occupant\n');
  bakeAs(root, name, dead, { reuse: false });
  assert.strictEqual(readCache(root, name, 'session'), dead,
    'ENTER: the dead session\'s baseline must be present, or "it was not inherited" is true for the wrong reason');

  const fresh = promptV();
  assert.strictEqual(bakeAs(root, name, fresh, { reuse: false }), fresh,
    'reuse=false must bake the new truth and not the cached bytes');
  assert.strictEqual(readCache(root, name, 'session'), fresh,
    'and reseed the baseline, so the next resume freezes onto the CURRENT conversation');
  assert.strictEqual(bakeAs(root, name, promptV('[agent:newverb] since\n'), { reuse: true }), fresh,
    'while reuse=true bakes the bytes this conversation was born with — the freeze itself');
});

// ------------------------------------------------------- MF2: no channel

test('MF2: NO FREEZE WITHOUT A CHANNEL — a user --settings must not reuse', async () => {
  // extraArgs carrying --settings is exactly the bypass: session-manager skips
  // setupClaudeHook, so ipcdelta.sh is never written and no staged delta could
  // ever be delivered. Driving the real create() is the point — the whole bug is
  // that this branch and the bake were decided independently.
  assert.strictEqual(await decidedReuse({ resumeId: 'sess-1', extraArgs: ['--settings', '/tmp/mine.json'] }, 'a --settings session'), false,
    'with no drain installed there is no way to deliver a diff, so freezing would leave this session permanently stale with NO mechanism that could ever repair it — strictly worse than the rewrite the freeze exists to avoid. Regenerating pays the token bust once and is CORRECT');
});

test('MF2: the same resume WITHOUT a user --settings does reuse — the pin is the channel', async () => {
  assert.strictEqual(await decidedReuse({ resumeId: 'sess-1' }, 'a normal resume'), true,
    'control: if this were also false, the test above would pass against a freeze that never happens for anyone');
});

test('MF2 precondition: a --settings session can SPAWN AT ALL — the prompt write ensures its own dir', async () => {
  // Found by driving the real create() for the MF2 pins above, and absorbed
  // into t63 on clodex's ruling: without this the whole MF2 path is dead
  // before it reaches the decision MF2 is about. run/<name>/ is created as a
  // side effect of setupClaudeHook, which is skipped precisely when the caller
  // supplies --settings, so the append-prompt write ENOENT'd and the session
  // never spawned. Pre-existing (the same shape predates t61); the freeze just
  // made it matter, because MF2's fix is unreachable while this crashes.
  //
  // Asserted BY MESSAGE, not by letting the ENOENT escape: a crash is what we
  // already had, and a test that proves a bug by crashing cannot tell a
  // regression apart from a broken harness.
  const { spawn, root } = reuseArgFor({ resumeId: 'sess-1', extraArgs: ['--settings', '/tmp/mine.json'] });
  assert.ok(!fs.existsSync(runDirFor(root, 'settings-probe')),
    'ENTER: run/<name>/ must NOT exist going in — that absence is the whole bug, and a pre-created dir would make this pass without testing anything');

  let err = null;
  try { await spawn('settings-probe'); } catch (e) { err = e; }
  assert.strictEqual(err, null,
    `a session whose own --settings skips Clodex's hook setup must still spawn: nothing else creates run/<name>/ before the append-prompt write, so the write has to ensure its own dir (same idiom as the socket bind's ensureDir ~90 lines below). Got: ${err && err.message}`);
  assert.ok(fs.existsSync(pathFor(root, 'settings-probe', 'appendPrompt')),
    'and the prompt must actually be on disk — create() returning without throwing is not enough when the write is the thing under test');
});

test('MF2: a --settings session is WARNED, not silently degraded', async () => {
  const { spawn } = reuseArgFor({ resumeId: 'sess-1', extraArgs: ['--settings', '/tmp/mine.json'] });
  const out = await spawn('warned-probe');
  assert.ok(Array.isArray(out.warnings) && out.warnings.length >= 1,
    'ENTER: create() must return warnings for this session, or the assertion below inspects nothing');
  assert.ok(out.warnings.some((w) => /--settings/.test(w) && /IPC/.test(w)),
    'the operator must be told their own --settings disabled the protocol-change channel — "looks healthy, delivers nothing" is the shape the last release was about');
});

// --------------------------------------------------- MF1: the context reset

// Run the REAL generated SessionStart script with a given `source`, the same way
// the CLI invokes it: hook JSON on stdin. Hand-simulating the reset would pin my
// idea of it; the ORDER inside that script is the mechanism.
function runSessionStart(root, name, source) {
  const transcript = path.join(root, 'fake-transcript.jsonl');
  fs.writeFileSync(transcript, '');
  const script = pathFor(root, name, 'hook');
  const r = require('child_process').spawnSync('/bin/bash', [script], {
    encoding: 'utf8',
    input: JSON.stringify({ transcript_path: transcript, source }),
  });
  assert.strictEqual(r.status, 0, `SessionStart hook exited ${r.status}: ${r.stderr}`);
  return r.stdout;
}

// Run the REAL generated drain, so notified.md advances the way it does in
// production (only the drain ever writes it).
function runDrain(root, name) {
  const script = pathFor(root, name, 'ipcdeltaScript');
  const r = require('child_process').spawnSync('/bin/bash', [script], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, `drain exited ${r.status}: ${r.stderr}`);
  return r.stdout.trim();
}

// A session in the state the bug is actually about: POST-DELIVERY. One delta has
// been delivered and absorbed (so notified.md has advanced past session.md), and
// a second change is staged and waiting.
//
// Getting here matters, and my first draft got it wrong: straight after a spawn
// notified.md still EQUALS session.md — nothing has been delivered yet — so a
// fixture that skipped the drain would have "proved" the reset works while
// asserting a state the reset cannot be distinguished in. Only the drain
// advances the baseline, so only after a drain is there anything for a context
// reset to lose.
function stagedSession(root, name) {
  hooks(root).setupClaudeHook(name);
  const born = promptV();
  bakeAs(root, name, born, { reuse: false });

  // Change #1: staged, then actually DELIVERED — this is the delta the context
  // reset destroys, and delivering it is what advances notified.md past born.
  bakeAs(root, name, promptV('[agent:newverb] shipped since\n'), { reuse: true });
  const emitted = runDrain(root, name);
  assert.ok(emitted, 'ENTER: the first delta must actually have been DELIVERED — that delivery is what advances notified.md, and an undelivered delta is not the state this bug is about');

  // Change #2: staged and still waiting when the reset fires.
  bakeAs(root, name, promptV('[agent:newverb] shipped since\n[agent:another] and another\n'), { reuse: true });

  assert.ok(fs.existsSync(cachePathFor(root, name, 'delta')),
    'ENTER: a delta must be staged before the reset runs — otherwise "delta.md was removed" is true because it never existed');
  assert.notStrictEqual(readCache(root, name, 'notified'), born,
    'ENTER: notified.md must have ADVANCED past session.md going in, or "the reset set them equal" is true by accident rather than by reset');
  return born;
}

for (const source of ['clear', 'compact']) {
  test(`MF1: source=${source} resets the baseline to session.md and invalidates the staged pair`, () => {
    const root = tmp(), name = `reset-${source}`;
    const born = stagedSession(root, name);

    runSessionStart(root, name, source);

    assert.strictEqual(readCache(root, name, 'notified'), born,
      `a ${source} destroys everything delivered through UserPromptSubmit (dropped outright, or summarized away with the rest of the messages array), while the SYSTEM PROMPT survives — and it holds session.md. notified.md means "what this agent has been told BEYOND its system prompt", so after a context reset that is exactly session.md`);
    assert.ok(!fs.existsSync(cachePathFor(root, name, 'delta')),
      'the staged delta was computed against the OLD baseline, so it must be invalidated — draining it after the reset would advance notified.md past a delta this reset just made wrong');
    assert.ok(!fs.existsSync(cachePathFor(root, name, 'next')),
      'and its paired next.md with it — a next.md whose delta.md is gone is inert, but leaving it is residue that the next stage would overwrite anyway');
  });
}

test('MF1: the reset does NOT re-deliver the last delta — it resets the baseline and lets the machinery regenerate', () => {
  const root = tmp(), name = 'regen';
  const born = stagedSession(root, name);
  runSessionStart(root, name, 'compact');

  // The agent is owed BOTH changes — the one delivered before the compact (and
  // summarized away with it) and the one still staged when it fired. The baseline
  // is reset to session.md and the machinery re-stages whatever is now missing,
  // which covers both. Replaying the last delta would have covered only the
  // second, which is why the baseline is reset rather than the delta replayed.
  const v3 = promptV('[agent:newverb] shipped since\n[agent:another] and another\n');
  bakeAs(root, name, v3, { reuse: true });
  const staged = readCache(root, name, 'delta');
  assert.ok(staged, 'a delta must be staged: the reset re-anchored the baseline to session.md, so BOTH changes are now missing relative to it');
  assert.ok(staged.includes('[agent:newverb]') && staged.includes('[agent:another]'),
    'and it must carry both changes — the one summarized away AND the one staged when the compact fired. Re-delivering only the last staged delta would silently drop the first');
});

// session.md has EXACTLY ONE WRITER, and this hook is not it.
//
// The regenerate-at-a-reset property is real and load-bearing: bakePrompt's
// `baked == null` branch is that one writer, so a session that keeps the file is
// served its first-ever bake forever — every ordinary restart passes a resumeId
// (reuse=true), which reads it and hands it back unchanged. A live seat ran six
// days on a frozen prompt this way. But the regeneration is session-manager's
// refreshPrompt, which re-bakes AND rewrites append-prompt.md in one step while
// the seat is live. Dropping the file here instead raced that refresh and lost:
// the refresh commonly runs first, early-returns at its already-current guard,
// and then this unlink lands — leaving a LIVE seat with no session.md until its
// next ordinary resume re-bakes under a conversation 100k+ tokens deep, which is
// the exact bust the module exists to prevent.
for (const source of ['clear', 'compact']) {
  test(`MF1: source=${source} does NOT touch session.md — refreshPrompt is its sole writer`, () => {
    const root = tmp(), name = `rebake-${source}`;
    const born = stagedSession(root, name);
    assert.strictEqual(readCache(root, name, 'session'), born,
      'ENTER: session.md must exist going in, or "it was left alone" is true because it was never there');

    runSessionStart(root, name, source);

    assert.strictEqual(readCache(root, name, 'session'), born,
      `a ${source} hook must leave session.md exactly as it found it. Unlinking it here cannot be coordinated with the in-process refresh that fires at the same edge, and the losing ordering strands a live seat with no frozen prompt at all — a deferred, unbounded rewrite of a warm conversation`);
    assert.strictEqual(readCache(root, name, 'notified'), born,
      'the baseline IS reset to it though — that half is this hook\'s job and needs no coordination: after a context reset, what the agent has been told is exactly what its surviving system prompt says');
  });
}

// The generated script is byte-pinned elsewhere in this file; this pins the one
// absence that a future edit is most likely to "restore" as a fix.
test('MF1: the SessionStart reset never unlinks session.md', () => {
  const root = tmp(), name = 'nounlink';
  hooks(root).setupClaudeHook(name);
  const body = fs.readFileSync(pathFor(root, name, 'hook'), 'utf8');
  const reset = body.slice(body.indexOf('RESETEOF'), body.lastIndexOf('RESETEOF'));
  assert.ok(reset.length > 0, 'ENTER: the reset block must be found, or the assertion below is vacuous');
  assert.ok(!/unlinkSync\([^)]*session\.md/.test(reset),
    'the reset must not unlink session.md: a second writer racing refreshPrompt is how a live seat ends up with none');
});

for (const source of ['startup', 'resume']) {
  test(`MF1: source=${source} must NOT reset the baseline`, () => {
    const root = tmp(), name = `noreset-${source}`;
    stagedSession(root, name);
    const before = readCache(root, name, 'notified');

    runSessionStart(root, name, source);

    assert.strictEqual(readCache(root, name, 'notified'), before,
      `${source} is not a context reset: the conversation's delivered history is intact, so resetting the baseline here would re-deliver a diff the agent already absorbed on every GUI restart`);
    assert.ok(fs.existsSync(cachePathFor(root, name, 'delta')),
      'and a delta staged by this very spawn must survive to be drained on the first submit — clearing it here would drop the change entirely');
    assert.ok(fs.existsSync(cachePathFor(root, name, 'session')),
      `nor may ${source} drop session.md: this is a LIVE conversation with a warm prefix cache, and re-baking it is the 111k-139k bust the freeze exists to prevent. Only a context reset earns the re-bake`);
  });
}

test('MF1: the reset unlinks the staged pair BEFORE writing the baseline', () => {
  // Both writes are inside one short-lived node process, so there is no way to
  // interrupt it from a test without faking the crash the order exists to
  // survive. Pin the order in the generated bytes, as this repo pins every other
  // hook script: reversing it is silent on the happy path and only shows up as a
  // baseline advanced past an invalidated delta.
  const root = tmp(), name = 'resetorder';
  hooks(root).setupClaudeHook(name);
  const body = fs.readFileSync(pathFor(root, name, 'hook'), 'utf8');

  const resetAt = body.indexOf('RESETEOF');
  assert.ok(resetAt > 0, 'ENTER: the SessionStart script must actually contain the reset block, or every offset below is -1 and the ordering assertions compare nothing');
  const unlinkAt = body.indexOf('unlinkSync', resetAt);
  const renameAt = body.indexOf('renameSync', resetAt);
  assert.ok(unlinkAt > 0 && renameAt > 0,
    'ENTER: the reset must contain both an unlink and the rename that publishes the new baseline');
  assert.ok(unlinkAt < renameAt,
    'the staged pair must be invalidated BEFORE the baseline is published: a torn run in that order leaves "no pair, old baseline", which the next spawn simply re-stages, whereas the reverse can leave a live delta whose drain advances the baseline past its own invalidation — the one unrecoverable outcome');
});

test('MF1: the reset reads the cache from the SHARED root, not the run dir it would outlive', () => {
  const root = tmp(), name = 'sharedroot';
  hooks(root).setupClaudeHook(name);
  const body = fs.readFileSync(pathFor(root, name, 'hook'), 'utf8');
  assert.ok(body.includes(promptCacheDir(root, name)),
    'the SessionStart script must point at promptcache/<name> at the shared root — cleanupClaudeHook rm -rf s run/<name>/ on every exit, so a reset reading from there would find nothing exactly when it matters');
});

// ------------------------------------------------ drain ordering (small fix)

test('the ipcdelta drain is registered FIRST under UserPromptSubmit', () => {
  const root = tmp(), name = 'ordering';
  hooks(root).setupClaudeHook(name);
  const settings = JSON.parse(fs.readFileSync(pathFor(root, name, 'settings'), 'utf8'));
  const cmds = settings.hooks.UserPromptSubmit[0].hooks.map((h) => h.command);

  const deltaIdx = cmds.findIndex((c) => c.endsWith('ipcdelta.sh'));
  assert.ok(deltaIdx >= 0,
    'ENTER: the drain must be registered at all — a findIndex of -1 would satisfy "it is not last" for the wrong reason');
  assert.ok(cmds.length > 1,
    'ENTER: there must be other drains to be ordered against, or "first" is meaningless');
  assert.strictEqual(deltaIdx, 0,
    'the protocol delta must come first: Claude concatenates additionalContext in registration order, and a change that can alter what the intents BELOW it even mean is the one thing that must not arrive underneath parked DMs and a context warning');
});
