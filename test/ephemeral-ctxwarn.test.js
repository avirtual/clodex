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
function harness({ ephemeral = false } = {}) {
  const root = tmp();
  let record = { name: 'seat', type: 'claude', createdAt: 1, ...(ephemeral ? { ephemeral: true } : {}) };
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
      get: () => record,
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
  m._sendToSession = () => {};

  return {
    m, root,
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

test('a NON-ephemeral seat over threshold gets the ctxwarn file', async () => {
  const h = harness({ ephemeral: false });
  h.writeCtx(OVER);
  await h.spawn();
  // ENTER for the whole file: this is what proves the machinery was armed at
  // this token count, in this fixture, on this path. Without it the skip below
  // is satisfied by a create() that never reached the ctx poll at all.
  assert.ok(fs.existsSync(h.warnPath()), 'the reminder must fire for an ordinary seat');
  assert.strictEqual(fs.readFileSync(h.warnPath(), 'utf8'), ctxReminderFor(OVER),
    'the file carries the pure decision verbatim — the write site suppresses, it does not reword');
});

test('an EPHEMERAL seat at the SAME token count gets no ctxwarn file', async () => {
  const h = harness({ ephemeral: true });
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

test('an ephemeral seat that was PREVIOUSLY nudged has its stale file removed', async () => {
  // The remove arm must stay reachable for a suppressed seat. A seat can cross
  // the threshold as non-ephemeral machinery wrote the file (or carry one left
  // by an older build), and skipping the write while also skipping the remove
  // would strand it — re-delivered on every submit forever, since the file's
  // mere presence is what drives the reminder.
  const h = harness({ ephemeral: true });
  h.writeCtx(OVER);
  fs.mkdirSync(runDirFor(h.root, 'seat'), { recursive: true });
  fs.writeFileSync(h.warnPath(), 'STALE REMINDER');
  assert.ok(fs.existsSync(h.warnPath()), 'ENTER: there is a stale file to strand');
  await h.spawn();
  assert.ok(!fs.existsSync(h.warnPath()), 'the stale reminder is cleared, not left to re-nag every turn');
});
