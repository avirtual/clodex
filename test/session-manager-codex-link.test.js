'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSessionManager } = require('../session-manager');
const { pathFor, runDirFor } = require('../clodex-paths');
const { mkTmpRoot } = require('./lib/tmp-roots');

const RESUME_ID = '01a0da2a-6469-7632-88a4-67b6ba1a041a';

function mkCodex({ pollMs = 1, deadlineMs = 60000 } = {}) {
  const root = mkTmpRoot('clx-codex-link-');
  const userData = mkTmpRoot('clx-codex-link-ud-');
  const home = path.join(root, 'codex-home');
  const work = fs.realpathSync(mkTmpRoot('clx-codex-link-work-'));
  fs.mkdirSync(home, { recursive: true });
  const spawns = [];
  const warns = [];
  const SessionManager = createSessionManager({
    knownSkillNames: () => [],
    REGISTRY_DIR: root,
    fs, path, pathFor, runDirFor,
    PENDING_DIR: path.join(root, 'pending'),
    MSG_DIR: path.join(root, 'messages'),
    ensureDir: (d) => fs.mkdirSync(d, { recursive: true }),
    getPersistence: () => ({ list: () => [], get: () => null, upsert: () => {}, remove: () => {}, setSessionId: () => {}, setStripLevel: () => {}, setLabel: () => {} }),
    getRemoteServer: () => null,
    getUiSettings: () => ({ get: () => ({}) }),
    getEnvScopes: () => ({ all: () => ({ global: {}, workspaces: {} }) }),
    getUserDataPath: () => userData,
    resolveProxyBase: () => null,
    lastTranscriptWrite: () => null,
    memoryStore: { list: () => [] },
    composeDigest: () => null,
    registry: { register: () => {}, unregister: () => {} },
    Transport: class { start() {} stop() {} },
    JsonlWatcher: class { start() {} stop() {} },
    pty: {
      spawn: (cmd, args, opts) => {
        spawns.push({ cmd, args, opts });
        return { onData() {}, onExit() {}, pid: 999, kill() {} };
      },
    },
    os,
    stripLevelOf: () => 0,
    notifyOS: () => {},
    log: { info: () => {}, warn: (scope, msg) => warns.push([scope, msg]), error: () => {} },
    resolveProxyAgentId: ({ name }) => name,
    getPromptLibrary: () => ({ list: () => [], get: () => null, raw: () => null }),
    setupCodexHook: (n) => fs.mkdirSync(runDirFor(root, n), { recursive: true }),
    cleanupCodexHook: () => {},
    buildIpcPrompt: () => '',
    readAppendBodies: () => [],
    pluginGrammarLines: () => [],
    mergeCodexInstructions: (a) => ({ cleaned: [...a], merged: '' }),
    deliverSkills: () => null,
    codexStatusLineArg: () => '',
  });
  const m = new SessionManager();
  m._sendToSession = () => {};
  m._broadcast = () => {};
  m._codexLinkPollMs = pollMs;
  m._codexLinkDeadlineMs = deadlineMs;
  const create = (name, resumeId = null) => m.create(
    name, 'codex', work, [], resumeId, 'ws', null, false, null,
    [], [], [], [], [], null, [], [], null, { CODEX_HOME: home },
  );
  const stop = (name) => {
    const s = m.sessions.get(name);
    if (!s) return;
    try { if (s.watcher) s.watcher.stop(); } catch {}
    try { if (s.ctxWatcher) s.ctxWatcher.close(); } catch {}
    clearTimeout(s._bootDrainTimer);
    m.sessions.delete(name);
  };
  const writeRollout = (day, file, cwd) => {
    const p = path.join(home, 'sessions', ...day.split('/'), file);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, `${JSON.stringify({ type: 'session_meta', payload: { id: 'x', cwd } })}\n`);
    return p;
  };
  const link = (name) => pathFor(root, name, 'transcript');
  return { m, home, work, spawns, warns, create, stop, writeRollout, link };
}

const today = () => new Date().toISOString().slice(0, 10).replace(/-/g, '/');

test('t1205: a fresh codex pty seat is linked to the rollout its TUI writes under the seat CODEX_HOME for its cwd', async () => {
  const f = mkCodex();
  await f.create('cx');
  const s = f.m.sessions.get('cx');
  try {
    assert.throws(() => fs.lstatSync(f.link('cx')), /ENOENT/, 'no rollout yet, no link');
    f.writeRollout(today(), 'rollout-2026-09-25T23-03-26-01a0da2a-0000-7000-8000-000000000009.jsonl', '/somewhere/else');
    await new Promise((r) => setTimeout(r, 10));
    assert.throws(() => fs.lstatSync(f.link('cx')), /ENOENT/, 'a rollout for another cwd is not this seat\'s');
    const target = f.writeRollout(today(), 'rollout-2026-09-25T23-03-27-01a0da2a-0000-7000-8000-000000000001.jsonl', f.work);
    assert.strictEqual(await s._codexLinkDone, 'linked');
    assert.strictEqual(fs.readlinkSync(f.link('cx')), target);
    assert.deepStrictEqual(f.warns, []);
  } finally { f.stop('cx'); }
});

test('t1205: a resumed codex pty seat is linked to the existing rollout named by its id, in whatever date dir it lives', async () => {
  const f = mkCodex();
  const target = f.writeRollout('2026/08/01', `rollout-2026-08-01T10-00-00-${RESUME_ID}.jsonl`, '/elsewhere');
  await f.create('cx', RESUME_ID);
  const s = f.m.sessions.get('cx');
  try {
    assert.deepStrictEqual(f.spawns[0].args.slice(-2), ['resume', RESUME_ID]);
    assert.strictEqual(await s._codexLinkDone, 'linked');
    assert.strictEqual(fs.readlinkSync(f.link('cx')), target);
  } finally { f.stop('cx'); }
});

test('t1205: a codex pty seat that never gets a rollout warns at the deadline and leaves no link', async () => {
  const f = mkCodex({ deadlineMs: 20 });
  await f.create('cx');
  const s = f.m.sessions.get('cx');
  try {
    assert.strictEqual(await s._codexLinkDone, 'deadline');
    assert.throws(() => fs.lstatSync(f.link('cx')), /ENOENT/);
    assert.deepStrictEqual(f.warns, [['codex', `cx: no rollout under ${path.join(f.home, 'sessions')} within 60000 ms — transcript link pending`]]);
  } finally { f.stop('cx'); }
});
