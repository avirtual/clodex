'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

const { mk: mkBase } = require('./lib/session-fixtures');
const { createSessionManager, EXEC_REPLY_WAIT_MS, EXEC_ACK_MIN_TIMEOUT_MS } = require('../session-manager');
const { isFilenameToken, parseAndValidate, clampReplyBody } = require('../exec-schema');
const { parkDelivery } = require('../pending-store');
const { mkTmpRoot } = require('./lib/tmp-roots');
const { pathFor, runDirFor } = require('../clodex-paths');
const { mintIntentCredential, seatChannelEnv } = require('../intent-socket');
const { seenIdent, consume: wireSaw, wire: seenWire } = require('./lib/wire-seen').wireSeenStamps();
const verb = require('../cli/bin/clodex.js');

const QUIET = { info() {}, warn() {}, error() {}, debug() {} };
const READ_DEF = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'resources', 'library', 'exec', 'clodex-ctl-read.json'), 'utf-8'));
const IOS_READ_DEF = { ...READ_DEF, schema: { ...READ_DEF.schema, properties: { ...READ_DEF.schema.properties, ctx: { type: 'string', enum: ['ios'] } } } };

const turns = async (n = 2) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };

function deferredCtl() {
  const calls = [];
  const svc = {
    run: (line) => new Promise((resolve) => {
      calls.push({ line, resolve: (output) => resolve({ command: line, ctx: 'ios', ts: 0, output, exitCode: 0 }) });
    }),
  };
  return { calls, svc };
}

function writeDef(REGISTRY_DIR, name, def) {
  const execDir = path.join(REGISTRY_DIR, 'library', 'exec');
  fs.mkdirSync(execDir, { recursive: true });
  fs.writeFileSync(path.join(execDir, `${name}.json`), JSON.stringify(def));
}

function scopeOf() {
  const lines = [];
  const state = { open: true };
  const replyTo = (t) => { if (!state.open) return false; lines.push(t); return true; };
  return { lines, state, replyTo };
}

test('exec under a reply scope: an inProcess ctl reply is captured by its own call and not injected', async () => {
  const REGISTRY_DIR = mkTmpRoot('clx-ctl-exec-');
  writeDef(REGISTRY_DIR, 'clodex-ctl-read', IOS_READ_DEF);
  const { calls, svc } = deferredCtl();
  const m = mkBase({
    log: QUIET, isFilenameToken, fs, path, os, REGISTRY_DIR,
    getCtlService: () => svc, clampReplyBody, parseAndValidate, resolveTeam: () => null,
    getPersistence: () => ({ list: () => [], get: () => ({ name: 'a', execCommands: ['clodex-ctl-read'] }) }),
    childProcess: { spawn: () => { throw new Error('spawned'); } },
  });
  const injected = [];
  m._injectText = (_s, text) => injected.push(text);
  m._broadcast = () => {};
  m.sessions.set('a', { name: 'a', agentType: 'claude', workspaceId: 'ws1', cwd: '/tmp' });
  const A = scopeOf();
  const B = scopeOf();
  const pa = m._handleIntent('a', { type: 'exec', cmd: 'clodex-ctl-read', body: '{"ctx":"ios","verb":"get","args":"A"}' }, { replyTo: A.replyTo });
  const pb = m._handleIntent('a', { type: 'exec', cmd: 'clodex-ctl-read', body: '{"ctx":"ios","verb":"get","args":"B"}' }, { replyTo: B.replyTo });
  await Promise.all([pa, pb]);
  await turns();
  assert.deepStrictEqual(calls.map((c) => c.line), ['--ctx ios get A', '--ctx ios get B']);
  calls[1].resolve('out B');
  calls[0].resolve('out A');
  await turns(4);
  assert.deepStrictEqual(B.lines, ['[agent:exec] clodex-ctl-read: [ctl ios exit 0] out B']);
  assert.deepStrictEqual(A.lines, ['[agent:exec] clodex-ctl-read: [ctl ios exit 0] out A']);
  assert.deepStrictEqual(injected, []);
  fs.rmSync(REGISTRY_DIR, { recursive: true, force: true });
});

function argvHarness(entry, { grants = ['digest'] } = {}) {
  const REGISTRY_DIR = mkTmpRoot('clx-runstatus-');
  writeDef(REGISTRY_DIR, 'digest', entry);
  const children = [];
  const SessionManager = createSessionManager({
    knownSkillNames: () => [],
    REGISTRY_DIR,
    PENDING_DIR: path.join(REGISTRY_DIR, 'pending'),
    parkDelivery,
    isFilenameToken,
    parseAndValidate,
    resolveTeam: () => ({ name: 't', root: '/proj/alpha' }),
    os,
    fs,
    path,
    log: QUIET,
    getPersistence: () => ({ list: () => [], get: () => ({ execCommands: grants }) }),
    intentEnabledForSeat: require('../intent-registry').intentEnabledForSeat,
    bodyModeFor: require('../intent-registry').bodyModeFor,
    childProcess: {
      spawn: () => {
        const ee = new EventEmitter();
        ee.pid = 4242;
        ee.stdin = { write() {}, end() {} };
        ee.stderr = new EventEmitter();
        ee.kill = () => {};
        children.push(ee);
        return ee;
      },
    },
  });
  const m = new SessionManager();
  const injected = [];
  const passive = [];
  const broadcasts = [];
  m._injectText = (_s, t) => injected.push(t);
  m._injectTextPassive = (_s, t) => passive.push(t);
  m._broadcast = (_ch, msg) => broadcasts.push(msg.body);
  const session = { name: 'a', agentType: 'claude', cwd: '/proj/alpha' };
  m.sessions.set('a', session);
  const cleanup = () => fs.rmSync(REGISTRY_DIR, { recursive: true, force: true });
  return { m, session, injected, passive, broadcasts, children, cleanup };
}

const TRACKED = { argv: ['/bin/true'], timeoutMs: 60000, replyStderr: true, schema: { type: 'object' } };
const UNTRACKED = { argv: ['/bin/true'], timeoutMs: 10000, schema: { type: 'object' } };
const ACK_NOTE = 'detached: a status line every 3m and the result arrive in your main conversation as [agent:exec] lines — do not poll or run it again; end your turn';

test('exec under a reply scope: a tracked run\'s ack is one JSON line in the reply and is not parked; the close result goes to the dm path once', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const { m, injected, passive, broadcasts, children, cleanup } = argvHarness(TRACKED);
  try {
    const S = scopeOf();
    await m._handleIntent('a', { type: 'exec', cmd: 'digest', body: '{}' }, { replyTo: S.replyTo });
    await turns();
    assert.strictEqual(children.length, 1);
    assert.strictEqual(S.lines.length, 1);
    assert.deepStrictEqual(JSON.parse(S.lines[0]), {
      status: 'started', runId: 1, cmd: 'digest', pid: 4242, ceilingMin: 1, statusEvery: '3m',
      lookup: { command: 'status', payload: { seq: 1 } }, note: ACK_NOTE,
    });
    assert.deepStrictEqual(passive, []);
    assert.ok(broadcasts.includes('started (run #1, pid 4242, ceiling 1m) — acknowledged in the socket reply'), JSON.stringify(broadcasts));
    S.state.open = false;
    children[0].stderr.emit('data', 'boom\n');
    children[0].emit('close', 1, null);
    assert.deepStrictEqual(injected, ['[agent:exec] digest: run #1 exit 1: boom']);
    assert.strictEqual(S.lines.length, 1);
  } finally { cleanup(); }
});

test('exec with no scope: the started notice is the unchanged passive text', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const { m, session, passive, children, cleanup } = argvHarness(TRACKED);
  try {
    m._handleExecIntent(session, 'digest', '{}');
    await turns();
    assert.strictEqual(children.length, 1);
    assert.deepStrictEqual(passive, ['[agent:exec] digest: started (run #1, pid 4242, ceiling 1m). Do not poll, do not re-emit — END YOUR TURN. A status line arrives every 3m and the result when it ends.']);
    children[0].emit('close', 0, null);
  } finally { cleanup(); }
});

test('M2 — two parallel calls to one tracked command get runIds 1 and 2, each in its own reply', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const { m, session, passive, children, cleanup } = argvHarness(TRACKED);
  try {
    const A = scopeOf();
    const B = scopeOf();
    await Promise.all([
      m._handleIntent('a', { type: 'exec', cmd: 'digest', body: '{"k":"A"}' }, { replyTo: A.replyTo }),
      m._handleIntent('a', { type: 'exec', cmd: 'digest', body: '{"k":"B"}' }, { replyTo: B.replyTo }),
    ]);
    await turns();
    assert.strictEqual(children.length, 2);
    assert.strictEqual(A.lines.length, 1);
    assert.strictEqual(B.lines.length, 1);
    assert.strictEqual(JSON.parse(A.lines[0]).runId, 1);
    assert.strictEqual(JSON.parse(B.lines[0]).runId, 2);
    assert.deepStrictEqual(session.execRuns.map((r) => r.seq), [1, 2]);
    assert.deepStrictEqual(passive, []);
    for (const c of children) c.emit('close', 0, null);
  } finally { cleanup(); }
});

test('exec: a silent untracked success is captured as a synthetic ok line under a scope, and injects nothing without one', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const { m, session, injected, passive, children, cleanup } = argvHarness(UNTRACKED);
  try {
    const S = scopeOf();
    await m._handleIntent('a', { type: 'exec', cmd: 'digest', body: '{}' }, { replyTo: S.replyTo });
    await turns();
    assert.strictEqual(children.length, 1);
    assert.deepStrictEqual(S.lines, []);
    children[0].emit('close', 0, null);
    assert.deepStrictEqual(S.lines, ['[agent:exec] digest: ok (exit 0, no output)']);

    m._handleExecIntent(session, 'digest', '{}');
    await turns();
    assert.strictEqual(children.length, 2);
    children[1].emit('close', 0, null);
    assert.deepStrictEqual(injected, []);
    assert.deepStrictEqual(passive, []);
    assert.deepStrictEqual(S.lines, ['[agent:exec] digest: ok (exit 0, no output)']);
  } finally { cleanup(); }
});

test('exec: an ungranted command\'s refusal lists the seat\'s grants', async () => {
  for (const [grants, want] of [
    [['a', 'b'], '[agent:exec] nope: not granted to this seat (granted: a, b)'],
    [[], '[agent:exec] nope: not granted to this seat (granted: none)'],
    [['ok', '../x'], '[agent:exec] nope: not granted to this seat (granted: ok)'],
  ]) {
    const { m, session, injected, children, cleanup } = argvHarness(UNTRACKED, { grants });
    try {
      m._handleExecIntent(session, 'nope', '{}');
      await turns();
      assert.deepStrictEqual(injected, [want]);
      assert.strictEqual(children.length, 0);
    } finally { cleanup(); }
  }
});

test('EXEC_REPLY_WAIT_MS exceeds the tracked-run ack threshold', () => {
  assert.ok(EXEC_REPLY_WAIT_MS > EXEC_ACK_MIN_TIMEOUT_MS);
  assert.strictEqual(EXEC_REPLY_WAIT_MS, 70000);
});

test('_startIntentSocket waits for exec: the socket intent form returns the ctl reply inline and injects nothing', async () => {
  const root = mkTmpRoot('isock-sm-');
  writeDef(root, 'clodex-ctl-read', IOS_READ_DEF);
  const { calls, svc } = deferredCtl();
  const injected = [];
  const entries = { a: { intents: ['exec'], execCommands: ['clodex-ctl-read'] } };
  const m = mkBase({
    REGISTRY_DIR: root,
    MSG_DIR: path.join(root, 'messages'),
    PENDING_DIR: path.join(root, 'pending'),
    pathFor,
    runDirFor,
    log: QUIET,
    registry: { listPeers: async () => [], getPeer: async () => null, register: () => {}, unregister: () => {} },
    getPeerManager: () => null,
    parseIntent: require('../intent-scanner').parseIntent,
    looksLikeIntent: require('../intent-scanner').looksLikeIntent,
    getPersistence: () => ({ list: () => [], get: (n) => entries[n] || null }),
    isFilenameToken, fs, path, os, getCtlService: () => svc, clampReplyBody, parseAndValidate, resolveTeam: () => null,
  });
  m._injectHoldReason = () => null;
  m._injectQueueFor = (s) => ({ enqueue: (t, o) => injected.push({ to: s.name, text: o && o.produce ? o.produce() : t }) });
  m._broadcast = () => {};
  const a = { name: 'a', agentType: 'claude', type: 'claude', io: 'pty', workspaceId: 'ws1', sessionId: 'sess-a', wireRouted: true };
  m._wire = seenWire;
  m.sessions.set('a', a);
  fs.mkdirSync(runDirFor(root, 'a'), { recursive: true });
  const cred = mintIntentCredential(crypto);
  const sockPath = pathFor(root, 'a', 'intentSocket');
  await m._startIntentSocket(a, { sockPath, cred });
  try {
    let out = '';
    let err = '';
    const env = { ...seatChannelEnv({ name: 'a', sockPath, cred }), CLODEX_HOOK_IDENT: seenIdent(crypto, cred, null, null, 'sess-a') };
    const call = verb.main(['[agent:exec clodex-ctl-read] {"ctx":"ios","verb":"get"}'], { env, out: { write: (t) => { out += t; } }, err: { write: (t) => { err += t; } } });
    for (let i = 0; i < 50 && !calls.length; i++) await turns(1);
    assert.deepStrictEqual(calls.map((c) => c.line), ['--ctx ios get']);
    await turns(10);
    calls[0].resolve('NAME  STATE');
    const code = await call;
    assert.strictEqual(code, 0, err);
    assert.strictEqual(out, '[agent:exec] clodex-ctl-read: [ctl ios exit 0] NAME  STATE\n');
    assert.deepStrictEqual(injected, []);
  } finally {
    a.intentSocket.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

const WAKE = (wake) => ({ argv: ['/bin/true'], timeoutMs: 10000, replyStderr: true, schema: { type: 'object' }, ...(wake ? { wake } : {}) });

test('wake error: an exit-0 result rides passively and does not wake the seat', async () => {
  const { m, session, injected, passive, children, cleanup } = argvHarness(WAKE('error'));
  try {
    m._handleExecIntent(session, 'digest', '{}');
    await turns();
    children[0].stderr.emit('data', 'answer ok\n');
    children[0].emit('close', 0, null);
    assert.deepStrictEqual(passive, ['[agent:exec] digest: answer ok']);
    assert.deepStrictEqual(injected, []);
  } finally { cleanup(); }
});

test('wake error: a non-zero exit still wakes the seat', async () => {
  const { m, session, injected, passive, children, cleanup } = argvHarness(WAKE('error'));
  try {
    m._handleExecIntent(session, 'digest', '{}');
    await turns();
    children[0].stderr.emit('data', 'boom\n');
    children[0].emit('close', 2, null);
    assert.deepStrictEqual(injected, ['[agent:exec] digest: exit 2: boom']);
    assert.deepStrictEqual(passive, []);
  } finally { cleanup(); }
});

test('wake never: an exit-0 result injects nothing but the message log still carries it', async () => {
  const { m, session, injected, passive, broadcasts, children, cleanup } = argvHarness(WAKE('never'));
  try {
    m._handleExecIntent(session, 'digest', '{}');
    await turns();
    children[0].stderr.emit('data', 'answer ok\n');
    children[0].emit('close', 0, null);
    assert.deepStrictEqual(injected, []);
    assert.deepStrictEqual(passive, []);
    assert.ok(broadcasts.includes('ok: answer ok'), JSON.stringify(broadcasts));
  } finally { cleanup(); }
});

test('wake absent: an exit-0 result wakes the seat as before', async () => {
  const { m, session, injected, passive, children, cleanup } = argvHarness(WAKE(null));
  try {
    m._handleExecIntent(session, 'digest', '{}');
    await turns();
    children[0].stderr.emit('data', 'answer ok\n');
    children[0].emit('close', 0, null);
    assert.deepStrictEqual(injected, ['[agent:exec] digest: answer ok']);
    assert.deepStrictEqual(passive, []);
  } finally { cleanup(); }
});

test('wake error under a reply scope: the scope captures the result line', async () => {
  const { m, injected, passive, children, cleanup } = argvHarness(WAKE('error'));
  try {
    const S = scopeOf();
    const p = m._handleIntent('a', { type: 'exec', cmd: 'digest', body: '{}' }, { replyTo: S.replyTo });
    await turns();
    children[0].stderr.emit('data', 'answer ok\n');
    children[0].emit('close', 0, null);
    await p;
    assert.deepStrictEqual(S.lines, ['[agent:exec] digest: answer ok']);
    assert.deepStrictEqual(passive, []);
    assert.deepStrictEqual(injected, []);
  } finally { cleanup(); }
});

test('wake with an unknown value: an exit-0 result wakes the seat', async () => {
  const { m, session, injected, passive, children, cleanup } = argvHarness(WAKE('bogus'));
  try {
    m._handleExecIntent(session, 'digest', '{}');
    await turns();
    children[0].stderr.emit('data', 'answer ok\n');
    children[0].emit('close', 0, null);
    assert.deepStrictEqual(injected, ['[agent:exec] digest: answer ok']);
    assert.deepStrictEqual(passive, []);
  } finally { cleanup(); }
});
