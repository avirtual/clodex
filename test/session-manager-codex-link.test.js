'use strict';

const { test, mock } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSessionManager } = require('../session-manager');
const { pathFor, runDirFor } = require('../clodex-paths');
const { mkTmpRoot } = require('./lib/tmp-roots');

const RESUME_ID = '01a0da2a-6469-7632-88a4-67b6ba1a041a';

function mkCodex({ pollMs = 1, deadlineMs = 60000, slowPollMs = 5000 } = {}) {
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
        return { onData() {}, onExit() {}, pid: 999, kill() {}, write() {} };
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
    isHumanPtyInput: () => false,
  });
  const m = new SessionManager();
  m._sendToSession = () => {};
  m._broadcast = () => {};
  m._codexLinkPollMs = pollMs;
  m._codexLinkDeadlineMs = deadlineMs;
  m._codexLinkSlowPollMs = slowPollMs;
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
    f.m.write('cx', 'hi');
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

const until = async (pred) => { while (!pred()) await new Promise((r) => setTimeout(r, 2)); };

test('t1205: a codex pty seat with no rollout by the deadline warns once, keeps polling, and links a rollout born after it', async () => {
  const f = mkCodex({ deadlineMs: 20, slowPollMs: 3 });
  await f.create('cx');
  const s = f.m.sessions.get('cx');
  let outcome = null;
  s._codexLinkDone.then((o) => { outcome = o; });
  f.m.write('cx', 'hi');
  try {
    await until(() => f.warns.length > 0);
    await new Promise((r) => setTimeout(r, 20));
    assert.strictEqual(outcome, null, 'the deadline does not settle the link');
    assert.throws(() => fs.lstatSync(f.link('cx')), /ENOENT/);
    assert.deepStrictEqual(f.warns, [['codex', `cx: no rollout under ${path.join(f.home, 'sessions')} after 60 s — still polling every 5 s`]]);
    const target = f.writeRollout(today(), 'rollout-2026-09-25T23-03-27-01a0da2a-0000-7000-8000-000000000001.jsonl', f.work);
    assert.strictEqual(await s._codexLinkDone, 'linked');
    assert.strictEqual(fs.readlinkSync(f.link('cx')), target);
  } finally { f.stop('cx'); }
});

test('t1205: the slow poll ends as gone when the seat goes, with no link', async () => {
  const f = mkCodex({ deadlineMs: 5, slowPollMs: 3 });
  await f.create('cx');
  const s = f.m.sessions.get('cx');
  await until(() => f.warns.length > 0);
  f.stop('cx');
  assert.strictEqual(await s._codexLinkDone, 'gone');
  assert.throws(() => fs.lstatSync(f.link('cx')), /ENOENT/);
});

test('t1207: a rollout born after spawn but before the seat was first typed into is not linked', async () => {
  const f = mkCodex();
  await f.create('cx');
  const s = f.m.sessions.get('cx');
  let outcome = null;
  s._codexLinkDone.then((o) => { outcome = o; });
  try {
    f.writeRollout(today(), 'rollout-2026-09-25T23-03-27-01a0da2a-0000-7000-8000-000000000001.jsonl', f.work);
    await new Promise((r) => setTimeout(r, 10));
    assert.strictEqual(outcome, null, 'an untyped seat links nothing');
    mock.timers.enable({ apis: ['Date'], now: Date.now() + 5000 });
    try { f.m.write('cx', 'hi'); } finally { mock.timers.reset(); }
    assert.ok(s.firstInputAt > s.spawnedAt + 4000);
    await new Promise((r) => setTimeout(r, 10));
    assert.strictEqual(outcome, null, 'a rollout older than the first input is not this seat\'s');
    assert.throws(() => fs.lstatSync(f.link('cx')), /ENOENT/);
  } finally { f.stop('cx'); }
});

test('t1207: a rollout born after the seat was first typed into is linked', async () => {
  const f = mkCodex();
  await f.create('cx');
  const s = f.m.sessions.get('cx');
  try {
    f.m.write('cx', 'hi');
    const target = f.writeRollout(today(), 'rollout-2026-09-25T23-03-27-01a0da2a-0000-7000-8000-000000000001.jsonl', f.work);
    assert.strictEqual(await s._codexLinkDone, 'linked');
    assert.strictEqual(fs.readlinkSync(f.link('cx')), target);
  } finally { f.stop('cx'); }
});

test('t1207: of two codex seats in one cwd, only the one typed into links the rollout', async () => {
  const f = mkCodex();
  await f.create('a');
  await f.create('b');
  const a = f.m.sessions.get('a');
  const b = f.m.sessions.get('b');
  let aOutcome = null;
  a._codexLinkDone.then((o) => { aOutcome = o; });
  try {
    f.m.write('b', 'hi');
    const target = f.writeRollout(today(), 'rollout-2026-09-25T23-03-27-01a0da2a-0000-7000-8000-000000000001.jsonl', f.work);
    await Promise.race([a._codexLinkDone, b._codexLinkDone]);
    await new Promise((r) => setTimeout(r, 10));
    assert.strictEqual(aOutcome, null);
    assert.strictEqual(fs.readlinkSync(f.link('b')), target);
    assert.throws(() => fs.lstatSync(f.link('a')), /ENOENT/);
  } finally { f.stop('a'); f.stop('b'); }
});
