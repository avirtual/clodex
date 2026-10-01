'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { intentEnabled } = require('../intent-catalog');
const { createSessionManager } = require('../session-manager');
const { pathFor, runDirFor } = require('../clodex-paths');
const { promptCacheDir } = require('../ipc-prompt-cache');
const { parseCtxFile } = require('../argv-merge');
const { ctxReminderFor, ctxThresholdsFor, CTX_THRESHOLD_MIN } = require('../ctx-reminder');
const { countPending } = require('../pending-store');
const { mkTmpRoot } = require('./lib/tmp-roots');

function harness(t) {
  const root = mkTmpRoot('clodex-t1532-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const record = { name: 'seat', type: 'claude', createdAt: 1 };
  let onRunDirEvent = null;
  const runDir = runDirFor(root, 'seat');
  const fsSpy = Object.assign(Object.create(fs), {
    watch: (p, ...rest) => {
      if (p === runDir) {
        onRunDirEvent = rest[rest.length - 1];
        return { close() {} };
      }
      return fs.watch(p, ...rest);
    },
  });
  const PENDING_DIR = path.join(root, 'pending');
  const SessionManager = createSessionManager({
    knownSkillNames: () => [],
    REGISTRY_DIR: root,
    fs: fsSpy, path, pathFor,
    promptCacheDir,
    PENDING_DIR,
    countPending,
    appVersion: '5.12.0',
    parseCtxFile,
    ctxReminderFor,
    ctxThresholdsFor,
    CTX_THRESHOLD_MIN,
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
    pluginGrammarLines: () => [], intentEnabled,
    mergeClaudeSystemPrompt: (args, ipcPrompt) => ({ cleaned: [...args], append: ipcPrompt }),
    cleanupClaudeHook: () => {},
    cleanupSkills: () => {}, cleanupAgentPlugin: () => {},
    ensureDir: (d) => fs.mkdirSync(d, { recursive: true }),
    MSG_DIR: path.join(root, 'messages'),
    runDirFor,
    registry: { register: () => {}, unregister: () => {} },
    Transport: class { constructor() {} start() {} stop() {} },
    JsonlWatcher: class { constructor() {} start() {} stop() {} },
    getAgentLibrary: () => ({ list: () => [] }),
    unionEnabled: () => [],
    writeAgentPlugin: () => null, effectiveInjectedAgents: () => [],
    deliverSkills: () => null, skillDeliveryProviders: () => ['claude', 'codex'],
    effectiveInjectedSkills: () => [],
    getRemoteServer: () => null,
    getUiSettings: () => ({ get: () => ({}) }),
    getPersistence: () => ({
      list: () => [record],
      get: (n) => (n === 'seat' ? record : null),
      upsert: () => {},
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
  const sent = [];
  m._broadcast = (channel, payload) => sent.push({ channel, payload });
  return {
    m, root, sent, PENDING_DIR,
    fire: (fname) => onRunDirEvent('change', fname),
    hasWatcher: () => typeof onRunDirEvent === 'function',
    append: (entry) => fs.appendFileSync(pathFor(root, 'seat', 'delivered'), JSON.stringify(entry) + '\n'),
    spawn: async () => {
      try {
        await m.create(
          'seat', 'claude', os.tmpdir(), [], null, 'ws', null, false, null,
          [], [], [], [], [], null, [], [], null, null, false,
        );
      } finally {
        const s = m.sessions.get('seat');
        if (s) {
          try { if (s.sentinel) s.sentinel.stop(); } catch {}
          try { if (s.watcher) s.watcher.stop(); } catch {}
          clearTimeout(s._bootDrainTimer);
        }
      }
    },
  };
}

const ofChannel = (sent, ch) => sent.filter((e) => e.channel === ch).map((e) => e.payload);

test('delivered.jsonl tail: a spooled line broadcasts a delivered ipc-message and the fresh pending-count', async (t) => {
  const h = harness(t);
  await h.spawn();
  t.after(() => { try { h.m._cleanup('seat'); } catch {} });
  assert.ok(h.hasWatcher(), 'the seat must have a run-dir watcher');
  fs.mkdirSync(path.join(h.PENDING_DIR, 'seat'), { recursive: true });
  fs.writeFileSync(path.join(h.PENDING_DIR, 'seat', '0009.json'), JSON.stringify({ text: 'still parked' }));
  h.m._lastPendingCounts.set('seat', 3);
  h.sent.length = 0;

  h.append({ ts: 1234, ev: 'PostToolUse', file: '0001.json', head: 'hello there' });
  h.fire('delivered.jsonl');

  assert.deepStrictEqual(ofChannel(h.sent, 'ipc-message'), [
    { ts: 1234, from: 'clodex', to: 'seat', kind: 'delivered', body: 'drained by PostToolUse hook: hello there' },
  ]);
  assert.deepStrictEqual(ofChannel(h.sent, 'pending-count'), [{ name: 'seat', count: 1 }]);
  assert.strictEqual(h.m._lastPendingCounts.get('seat'), 1);
});

test('delivered.jsonl tail: a second append broadcasts only the new line (offset tail, no replay)', async (t) => {
  const h = harness(t);
  await h.spawn();
  t.after(() => { try { h.m._cleanup('seat'); } catch {} });
  h.append({ ts: 1, ev: 'UserPromptSubmit', file: 'a.json', head: 'one' });
  h.fire('delivered.jsonl');
  h.sent.length = 0;

  h.append({ ts: 2, ev: 'PostToolUse', file: 'b.json', head: 'two' });
  h.fire('delivered.jsonl');

  const rows = ofChannel(h.sent, 'ipc-message');
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].body, 'drained by PostToolUse hook: two');
  assert.deepStrictEqual(ofChannel(h.sent, 'pending-count'), [{ name: 'seat', count: 0 }]);
  assert.ok(!h.m._lastPendingCounts.has('seat'));
});

test('delivered.jsonl tail: an attn.jsonl event does not read the delivered spool', async (t) => {
  const h = harness(t);
  await h.spawn();
  t.after(() => { try { h.m._cleanup('seat'); } catch {} });
  h.append({ ts: 1, ev: 'PostToolUse', file: 'a.json', head: 'one' });
  h.sent.length = 0;
  h.fire('attn.jsonl');
  assert.deepStrictEqual(ofChannel(h.sent, 'ipc-message'), []);
});
