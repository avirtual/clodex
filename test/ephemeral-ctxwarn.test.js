'use strict';

// t433 — an ephemeral seat is never nudged to compact.
//
// The pure decision (ctx-reminder.js) is unchanged and still says "heavy"; what
// this file pins is the WRITE SITE's suppression, driven through the real
// create() claude arm so the gate under test is the expression that ships.
//
// THE ENTER QUESTION. The interesting assertion is an ABSENCE (no ctxwarn file
// for an ephemeral seat), and absence passes for free against a setup that never
// reached the threshold, never spawned the claude arm, or wrote its ctx file
// somewhere the poll never looks. So the asymmetry is the assertion: both halves
// run against ONE fixture differing only in `ephemeral`, and the non-ephemeral
// half is the ENTER — it proves the reminder machinery was live and armed at
// this exact token count. Testing only the skip would pass just as green against
// a change that disabled the reminder for everybody.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createSessionManager } = require('../session-manager');
const { pathFor, runDirFor } = require('../clodex-paths');
const { promptCacheDir } = require('../ipc-prompt-cache');
const { parseCtxFile } = require('../argv-merge');
const { ctxReminderFor, CTX_REMINDER_NUDGE_TOKENS } = require('../ctx-reminder');

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'clodex-t433-')); }

// One fixture; `ephemeral` is the only thing either call varies. The real
// ctxReminderFor and parseCtxFile are injected, not spied: a stubbed decision
// would pin the harness's copy of the threshold rather than the shipped one.
function harness(t, { ephemeral = false, getThrows = false } = {}) {
  const root = tmp();
  // Three tmp trees leaked per run without this.
  if (t) t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let record = { name: 'seat', type: 'claude', createdAt: 1, ...(ephemeral ? { ephemeral: true } : {}) };
  // create() reads the record itself (existingEntry) BEFORE the session lands in
  // the map, while the ctx write site reads it after. Splitting the two is what
  // lets the memo be counted: a bare call count would be dominated by create's
  // own lookup and could not tell one write-site read from three.
  const getCalls = [];
  const writeSiteCalls = [];
  let mgr = null;
  const atWriteSite = () => !!(mgr && mgr.sessions.has('seat'));
  const SessionManager = createSessionManager({
    REGISTRY_DIR: root,
    fs, path, pathFor,
    promptCacheDir,
    PENDING_DIR: path.join(root, 'pending'),
    appVersion: '5.12.0',
    parseCtxFile,
    ctxReminderFor,
    versionNoticeFor: () => null,
    enqueueNotice: () => true,
    clearNotices: () => {},
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
    buildIpcPrompt: () => 'IPC PROTOCOL v1\n',
    pluginGrammarLines: () => [],
    mergeClaudeSystemPrompt: (args, ipcPrompt) => ({ cleaned: [...args], append: ipcPrompt }),
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
    getPersistence: () => ({
      list: () => (record ? [record] : []),
      // Discriminates on the argument: a `() => record` stub cannot tell
      // `get(name)` from `get(anything)`, so it would pass just as green against
      // a write site that looked up the wrong seat's record.
      get: (n) => {
        getCalls.push(n);
        if (atWriteSite()) {
          writeSiteCalls.push(n);
          // Only the write-site read fails, so create() still completes and the
          // seat under test genuinely reaches the over-threshold tick.
          if (getThrows) throw new Error('sessions.json unreadable');
        }
        return n === 'seat' ? record : null;
      },
      upsert: (e) => { record = { ...(record || {}), ...e }; },
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
  mgr = m;
  m._sendToSession = () => {};
  // _cleanup drops the session from the map; the object itself survives, and the
  // memo under test lives on it.
  let captured = null;

  return {
    m, root, getCalls, writeSiteCalls,
    session: () => captured,
    warnPath: () => pathFor(root, 'seat', 'ctxwarn'),
    // Written BEFORE create so the arm's initial readCtx() sees it. The poll is
    // otherwise fs.watch-driven, which is not synchronous enough to assert on.
    writeCtx: (tokens) => {
      fs.mkdirSync(runDirFor(root, 'seat'), { recursive: true });
      fs.writeFileSync(pathFor(root, 'seat', 'ctx'), `50\t${tokens}\t400000\tclaude-fable-5`);
    },
    spawn: async () => {
      try {
        return await m.create(
          'seat', 'claude', os.tmpdir(), [], null, 'ws', null, false, null,
          [], [], [], [], [], null, [], [], null, null, false,
        );
      } finally {
        const s = m.sessions.get('seat');
        captured = s || captured;
        if (s) {
          try { if (s.sentinel) s.sentinel.stop(); } catch {}
          try { if (s.watcher) s.watcher.stop(); } catch {}
          try { if (s.ctxWatcher) s.ctxWatcher.close(); } catch {}
          clearTimeout(s._bootDrainTimer);
        }
        try { m._cleanup('seat'); } catch {}
      }
    },
  };
}

const OVER = CTX_REMINDER_NUDGE_TOKENS + 10_000;

test('a NON-ephemeral seat over threshold gets the ctxwarn file', async (t) => {
  const h = harness(t, { ephemeral: false });
  h.writeCtx(OVER);
  await h.spawn();
  // ENTER for the whole file: this is what proves the machinery was armed at
  // this token count, in this fixture, on this path. Without it the skip below
  // is satisfied by a create() that never reached the ctx poll at all.
  assert.ok(fs.existsSync(h.warnPath()), 'the reminder must fire for an ordinary seat');
  assert.strictEqual(fs.readFileSync(h.warnPath(), 'utf8'), ctxReminderFor(OVER),
    'the file carries the pure decision verbatim — the write site suppresses, it does not reword');
});

test('an EPHEMERAL seat at the SAME token count gets no ctxwarn file', async (t) => {
  const h = harness(t, { ephemeral: true });
  h.writeCtx(OVER);
  await h.spawn();
  assert.ok(!fs.existsSync(h.warnPath()),
    'a seat sized to one ticket is never nudged: it would compact at `done`, discarding exactly the context the rework needs');
});

test('the pure decision is untouched — it still calls an ephemeral seat heavy', () => {
  // The suppression is the CALLER's, deliberately: "is this context heavy" and
  // "should we act on it" decay separately, and fusing them into the pure
  // function would make the threshold untestable without a seat identity.
  assert.ok(ctxReminderFor(OVER), 'ctxReminderFor takes tokens only and knows nothing of seats');
  assert.strictEqual(ctxReminderFor.length, 1, 'signature unchanged: no ephemeral parameter crept in');
});

test('an ephemeral seat that was PREVIOUSLY nudged has its stale file removed', async (t) => {
  // The remove arm must stay reachable for a suppressed seat. A seat can cross
  // the threshold as non-ephemeral machinery wrote the file (or carry one left
  // by an older build), and skipping the write while also skipping the remove
  // would strand it — re-delivered on every submit forever, since the file's
  // mere presence is what drives the reminder.
  const h = harness(t, { ephemeral: true });
  h.writeCtx(OVER);
  fs.mkdirSync(runDirFor(h.root, 'seat'), { recursive: true });
  fs.writeFileSync(h.warnPath(), 'STALE REMINDER');
  assert.ok(fs.existsSync(h.warnPath()), 'ENTER: there is a stale file to strand');
  await h.spawn();
  assert.ok(!fs.existsSync(h.warnPath()), 'the stale reminder is cleared, not left to re-nag every turn');
});

test('the record is looked up by THIS seat\'s name, exactly once, and memoized', async (t) => {
  const h = harness(t, { ephemeral: true });
  h.writeCtx(OVER);
  await h.spawn();
  // The lookup KEY, not just that a lookup happened: the stub returns null for
  // any other name, so a write site reading someone else's record would fall
  // through to "not ephemeral" and write the file.
  assert.deepStrictEqual(h.writeSiteCalls, ['seat'], 'one read, keyed by the seat under test');
  assert.ok(h.getCalls.every((n) => n === 'seat'), 'no lookup anywhere used a different key');
  // The memo is what makes every later tick free. get() re-parses all of
  // sessions.json and _load() can WRITE it (the legacy workspaceId backfill),
  // so an unmemoized read is a per-turn write for a seat parked over threshold.
  assert.strictEqual(h.session()._ephemeralSeat, true, 'settled on the session, so later ticks re-read nothing');
});

test('a persistence read that THROWS leaves the seat nudged, and unsettled', async (t) => {
  const h = harness(t, { ephemeral: true, getThrows: true });
  h.writeCtx(OVER);
  await h.spawn();
  assert.deepStrictEqual(h.writeSiteCalls, ['seat'], 'ENTER: the write site attempted the lookup, and it threw');
  // Degradation direction. Silence is the dangerous default: a seat that never
  // learns its context is heavy is worse off than one nudged unnecessarily, and
  // a record that is merely unreadable right now is not a claim of ephemerality.
  assert.ok(fs.existsSync(h.warnPath()), 'an unreadable record must not silently suppress the reminder');
  assert.strictEqual(h.session()._ephemeralSeat, undefined,
    'nothing memoized from a failed read, so a later tick can still settle it');
});
