'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const crypto = require('node:crypto');
const { mkTmpRoot } = require('./lib/tmp-roots');
const { mk } = require('./lib/session-fixtures');
const { pathFor, runDirFor } = require('../clodex-paths');
const { scanIntentLines } = require('../intent-segments');
const { subagentAllows } = require('../intent-registry');
const { createCliHooks } = require('../cli-hooks');
const {
  INTENT_SOCKET_MAX_BYTES, INTENT_SOCKET_MAX_CONNS, mintIntentCredential, seatChannelEnv,
  createIntentRequestHandler, createIntentSocketServer,
} = require('../intent-socket');
const verb = require('../cli/bin/clodex.js');

const CRED = 'c'.repeat(64);

function sockIn(root, name = 's1') {
  fs.mkdirSync(runDirFor(root, name), { recursive: true });
  return pathFor(root, name, 'intentSocket');
}

function send(sockPath, raw) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const c = net.createConnection(sockPath);
    c.on('connect', () => c.write(raw));
    c.on('data', (d) => { buf += d; });
    c.on('error', reject);
    c.on('close', () => { try { resolve(JSON.parse(buf.split('\n')[0])); } catch (e) { reject(e); } });
  });
}

const req = (o) => JSON.stringify(o) + '\n';

async function server(opts) {
  const root = mkTmpRoot('isock-');
  const sockPath = sockIn(root);
  const srv = createIntentSocketServer({ net, fs, crypto, sockPath, cred: CRED, ...opts });
  await srv.start();
  return { srv, sockPath, root };
}

function parse(text) {
  return scanIntentLines(text.split('\n'), {}).filter((s) => s.kind === 'intent').map((s) => s.intent);
}

test('the credential is 32 random bytes and the env names avoid KEY/SECRET/TOKEN', () => {
  const cred = mintIntentCredential(crypto);
  assert.match(cred, /^[0-9a-f]{64}$/);
  assert.notStrictEqual(cred, mintIntentCredential(crypto));
  const env = seatChannelEnv({ name: 's1', sockPath: '/x/intent.sock', cred });
  assert.deepStrictEqual(Object.keys(env).sort(), ['CLODEX_INTENT_CRED', 'CLODEX_INTENT_SOCK', 'CLODEX_SEAT']);
  for (const k of Object.keys(env)) assert.doesNotMatch(k, /KEY|SECRET|TOKEN/);
});

test('a wrong credential is refused as unauthorized and never reaches the handler', async () => {
  let called = 0;
  const { srv, sockPath } = await server({ handle: async () => { called++; return { ok: true, reply: 'x' }; } });
  try {
    assert.deepStrictEqual(await send(sockPath, req({ cred: 'd'.repeat(64), intent: '[agent:who]' })),
      { ok: false, error: 'unauthorized' });
    assert.deepStrictEqual(await send(sockPath, req({ intent: '[agent:who]' })), { ok: false, error: 'unauthorized' });
    assert.strictEqual(called, 0);
    assert.deepStrictEqual(await send(sockPath, req({ cred: CRED, intent: '[agent:who]' })), { ok: true, reply: 'x' });
    assert.strictEqual(called, 1);
    assert.strictEqual(fs.statSync(sockPath).mode & 0o777, 0o600);
  } finally { srv.stop(); }
});

test('a request over the 64KB intent cap is refused before parsing', async () => {
  let called = 0;
  const { srv, sockPath } = await server({ handle: async () => { called++; return { ok: true, reply: '' }; } });
  try {
    const big = req({ cred: CRED, intent: `[agent:dm b] ${'x'.repeat(INTENT_SOCKET_MAX_BYTES)}` });
    assert.deepStrictEqual(await send(sockPath, big), { ok: false, error: 'request too large' });
    assert.strictEqual(called, 0);
  } finally { srv.stop(); }
});

test('a ninth concurrent connection is refused busy while eight are in flight', async () => {
  const held = [];
  let allIn;
  const in8 = new Promise((r) => { allIn = r; });
  const { srv, sockPath } = await server({
    handle: () => new Promise((resolve) => {
      held.push(resolve);
      if (held.length === INTENT_SOCKET_MAX_CONNS) allIn();
    }),
  });
  try {
    const pending = [];
    for (let i = 0; i < INTENT_SOCKET_MAX_CONNS; i++) pending.push(send(sockPath, req({ cred: CRED, intent: '[agent:who]' })));
    await in8;
    assert.deepStrictEqual(await send(sockPath, req({ cred: CRED, intent: '[agent:who]' })), { ok: false, error: 'busy' });
    for (const r of held) r({ ok: true, reply: 'done' });
    const out = await Promise.all(pending);
    assert.ok(out.every((o) => o.ok && o.reply === 'done'));
  } finally { srv.stop(); }
});

test('a request past the timeout answers timeout and closes the reply sink', async () => {
  let fire = null;
  let ctl = null;
  let handled;
  const inHandle = new Promise((r) => { handled = r; });
  const { srv, sockPath } = await server({
    setTimer: (fn) => { fire = fn; return 1; },
    clearTimer: () => {},
    handle: (_r, c) => { ctl = c; handled(); return new Promise(() => {}); },
  });
  try {
    const p = send(sockPath, req({ cred: CRED, intent: '[agent:who]' }));
    await inHandle;
    assert.strictEqual(ctl.closed(), false);
    fire();
    assert.deepStrictEqual(await p, { ok: false, error: 'timeout' });
    assert.strictEqual(ctl.closed(), true, 'a late acknowledgement must fall through to the seat, not the closed socket');
  } finally { srv.stop(); }
});

const GRANTED = { execCommands: ['clodex-run-tests'] };
const TABLE = [
  ['[agent:dm reviewer] which file', 'dm', true],
  ['[agent:who]', 'who', true],
  ['[agent:name]', 'name', true],
  ['[agent:task list]', 'task list', true],
  ['[agent:exec clodex-run-tests] {}', 'exec clodex-run-tests', true],
  ['[agent:exec clodex-team] {}', 'exec clodex-team', false],
  ['[agent:exec status] {}', 'exec status', false],
  ['[agent:memory recall] pins', 'memory recall', true],
  ['[agent:memory list]', 'memory list', true],
  ['[agent:memory remember] x', 'memory remember', false],
  ['[agent:memory forget] x', 'memory forget', false],
  ['[agent:task add] spec', 'task add', false],
  ['[agent:task start t1]', 'task start', false],
  ['[agent:task assign t1 bob]', 'task assign', false],
  ['[agent:task accept t1] ok', 'task accept', false],
  ['[agent:task reject t1] no', 'task reject', false],
  ['[agent:task respec t1] x', 'task respec', false],
  ['[agent:task cancel t1] x', 'task cancel', false],
  ['[agent:task done t1] r', 'task done', false],
  ['[agent:task park t1]', 'task park', false],
  ['[agent:shout] x', 'shout', false],
  ['[agent:spawn name:x]', 'spawn', false],
  ['[agent:reboot] x', 'reboot', false],
  ['[agent:term exec] ls', 'term exec', false],
  ['[agent:team role-rm hand]', 'team role-rm', false],
  ['[agent:context compact]', 'context compact', false],
  ['[agent:remind in 5m] x', 'remind', false],
  ['[agent:scratch begin]', 'scratch begin', false],
  ['[agent:file view x.md]', 'file view', false],
  ['[agent:resend abc123]', 'resend', false],
];

for (const [line, label, allowed] of TABLE) {
  test(`subagent catalog: ${label} is ${allowed ? 'allowed' : 'refused'}`, async () => {
    const intents = parse(`${line}\n[agent:end]`);
    assert.strictEqual(intents.length, 1, `fixture line parses: ${line}`);
    assert.strictEqual(subagentAllows(intents[0], GRANTED), allowed);
    const seen = [];
    const handle = createIntentRequestHandler({
      seat: 'h1', parse, entryOf: () => GRANTED, sessionIdOf: () => 'main-thread', allows: subagentAllows,
      dispatch: async (intent, opts) => { seen.push(opts.fromLabel); },
    });
    const r = await handle({ intent: line, agentId: 'agent-7' }, { closed: () => false });
    if (allowed) {
      assert.strictEqual(r.ok, true);
      assert.deepStrictEqual(seen, ['h1/agent']);
    } else {
      assert.deepStrictEqual(r, { ok: false, error: `not available to a subagent: ${label}` });
      assert.deepStrictEqual(seen, [], 'a refusal dispatches nothing');
    }
    const main = await handle({ intent: line }, { closed: () => false });
    assert.strictEqual(main.ok, true, 'no agentId: the seat\'s full catalog');
    const mainThread = await handle({ intent: line, agentId: 'main-thread' }, { closed: () => false });
    assert.strictEqual(mainThread.ok, true, 'the seat\'s own thread id is the main agent');
  });
}

function seatHarness() {
  const root = mkTmpRoot('isock-sm-');
  const logs = [];
  const broadcasts = [];
  const injected = [];
  const delivered = [];
  const entries = { a: { execCommands: ['clodex-run-tests'] }, b: {} };
  const logger = {};
  for (const k of ['info', 'debug', 'warn', 'error']) logger[k] = (...a) => logs.push(a.join(' '));
  const m = mk({
    REGISTRY_DIR: root,
    MSG_DIR: path.join(root, 'messages'),
    PENDING_DIR: path.join(root, 'pending'),
    pathFor,
    runDirFor,
    log: logger,
    registry: { listPeers: async () => [], getPeer: async () => null, register: () => {}, unregister: () => {} },
    getPeerManager: () => null,
    getPersistence: () => ({ list: () => [], get: (n) => entries[n] || null }),
  });
  m._broadcast = (...a) => broadcasts.push(JSON.stringify(a));
  m._injectHoldReason = () => null;
  m._injectQueueFor = (s) => ({ enqueue: (t) => injected.push({ to: s.name, text: t }) });
  m._gatedDeliver = (target, tag, body) => { delivered.push({ target, tag, body }); return { queued: true }; };
  const a = { name: 'a', agentType: 'claude', type: 'claude', io: 'pty', workspaceId: 'ws1', sessionId: 'sess-a' };
  const b = { name: 'b', agentType: 'claude', type: 'claude', io: 'pty', workspaceId: 'ws1' };
  m.sessions.set('a', a);
  m.sessions.set('b', b);
  return { m, root, a, logs, broadcasts, injected, delivered };
}

function sink() {
  const s = { buf: '', write: (t) => { s.buf += t; } };
  return s;
}

async function viaVerb(h, cred, argv, extraEnv = {}) {
  const out = sink();
  const err = sink();
  const env = { ...seatChannelEnv({ name: 'a', sockPath: pathFor(h.root, 'a', 'intentSocket'), cred }), ...extraEnv };
  const code = await verb.main(argv, { env, out, err });
  return { code, out: out.buf, err: err.buf };
}

async function withSeat(fn) {
  const h = seatHarness();
  fs.mkdirSync(runDirFor(h.root, 'a'), { recursive: true });
  const cred = mintIntentCredential(crypto);
  await h.m._startIntentSocket(h.a, { sockPath: pathFor(h.root, 'a', 'intentSocket'), cred });
  try { await fn(h, cred); } finally { h.a.intentSocket.stop(); }
}

test('reply capture: who returns the roster line to the caller and injects nothing into the seat', async () => {
  await withSeat(async (h, cred) => {
    const r = await viaVerb(h, cred, ['[agent:who]']);
    assert.strictEqual(r.code, 0, r.err);
    assert.match(r.out, /^\[agent:peers\] b\b/);
    assert.deepStrictEqual(h.injected, [], 'the acknowledgement went to the socket, not the PTY');
    const n = await viaVerb(h, cred, ['[agent:name]'], { CODEX_THREAD_ID: 'thread-9' });
    assert.strictEqual(n.out, '[agent:name] a\n');
    assert.deepStrictEqual(h.injected, []);
  });
});

test('an async verb says where its answer arrives, and a subagent dm is sent as <seat>/agent', async () => {
  await withSeat(async (h, cred) => {
    const r = await viaVerb(h, cred, ['[agent:dm', 'b]', 'which', 'file'], { CLODEX_AGENT_ID: 'agent-7' });
    assert.strictEqual(r.code, 0, r.err);
    assert.strictEqual(r.out, "sent to b; a reply arrives in the seat's main conversation\n");
    assert.deepStrictEqual(h.delivered, [{ target: 'b', tag: 'a/agent', body: 'which file' }]);
    const main = await viaVerb(h, cred, ['[agent:dm b] hi']);
    assert.strictEqual(main.code, 0);
    assert.strictEqual(h.delivered[1].tag, 'a', 'the main agent still sends as the seat');
    assert.deepStrictEqual(h.injected, []);
  });
});

test('a subagent is refused a lead verb with exit 3, and the main agent is not', async () => {
  await withSeat(async (h, cred) => {
    const r = await viaVerb(h, cred, ['[agent:shout] approve?'], { CLODEX_AGENT_ID: 'agent-7' });
    assert.strictEqual(r.code, verb.EXIT.DENIED);
    assert.strictEqual(r.err, 'clodex: not available to a subagent: shout\n');
    const g = await viaVerb(h, cred, ['[agent:exec clodex-team] {}'], { CLODEX_AGENT_ID: 'agent-7' });
    assert.strictEqual(g.code, verb.EXIT.DENIED);
    const bad = await viaVerb(h, 'e'.repeat(64), ['[agent:who]']);
    assert.strictEqual(bad.code, verb.EXIT.DENIED);
    assert.strictEqual(bad.err, 'clodex: unauthorized\n');
  });
});

test('the seat credential appears in no log line and no ipc broadcast', async () => {
  await withSeat(async (h, cred) => {
    await viaVerb(h, cred, ['[agent:who]']);
    await viaVerb(h, cred, ['[agent:dm b] x'], { CLODEX_AGENT_ID: 'agent-7' });
    await viaVerb(h, cred, ['[agent:shout] x'], { CLODEX_AGENT_ID: 'agent-7' });
    await viaVerb(h, cred, ['[agent:bogus thing]']);
    await viaVerb(h, cred, ['[agent:exec clodex-run-tests] {}'], { CLODEX_AGENT_ID: 'agent-7' });
    assert.ok(h.broadcasts.length > 0, 'the run produced broadcasts to inspect');
    for (const line of [...h.logs, ...h.broadcasts]) assert.ok(!line.includes(cred), `cred leaked: ${line.slice(0, 80)}`);
    assert.ok(!JSON.stringify(h.a).includes(cred), 'the session record does not serialize the credential');
    assert.strictEqual(h.a.intentCred, cred);
  });
});

test('dropping run/<name>/ on exit unlinks the live intent socket', async () => {
  const root = mkTmpRoot('isock-sweep-');
  const hooks = createCliHooks({
    REGISTRY_DIR: root,
    memoryStore: { list: () => [] },
    getUiSettings: () => ({ get: () => ({ statusline: { claude: [], claudeCommand: '' } }) }),
    nodeInterp: process.execPath,
  });
  hooks.setupClaudeHook('s1');
  const sockPath = pathFor(root, 's1', 'intentSocket');
  const srv = createIntentSocketServer({ net, fs, crypto, sockPath, cred: CRED, handle: async () => ({ ok: true }) });
  await srv.start();
  try {
    assert.ok(fs.lstatSync(sockPath).isSocket());
    hooks.cleanupClaudeHook('s1');
    assert.strictEqual(fs.existsSync(sockPath), false);
  } finally { srv.stop(); }
});
