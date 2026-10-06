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
  createIntentRequestHandler, createIntentSocketServer, identToken, isMainThread, stampClodexCommand, IDENT_SEEN_MAX, IDENT_SEEN_MS,
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

test('a {cred, tool, args} request reaches the handler as tool and args; a wrong cred is unauthorized first', async () => {
  const got = [];
  const { srv, sockPath } = await server({ handle: async (r) => { got.push(r); return { ok: true, reply: 'x' }; } });
  try {
    assert.deepStrictEqual(await send(sockPath, req({ cred: 'd'.repeat(64), tool: 'browser', args: { verb: 'read' } })), { ok: false, error: 'unauthorized' });
    assert.deepStrictEqual(got, []);
    assert.deepStrictEqual(await send(sockPath, req({ cred: CRED, tool: 'browser', args: { verb: 'read' } })), { ok: true, reply: 'x' });
    assert.deepStrictEqual(got, [{ intent: undefined, tool: 'browser', args: { verb: 'read' }, agentId: undefined, agentType: undefined, ident: undefined }]);
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
  ['[agent:dm reviewer] which file', 'dm', false],
  ['[agent:who]', 'who', false],
  ['[agent:name]', 'name', false],
  ['[agent:task list]', 'task list', false],
  ['[agent:exec clodex-run-tests] {}', 'exec clodex-run-tests', false],
  ['[agent:exec clodex-team] {}', 'exec clodex-team', false],
  ['[agent:exec status] {}', 'exec status', false],
  ['[agent:memory recall] pins', 'memory recall', false],
  ['[agent:memory list]', 'memory list', false],
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
      seat: 'h1', parse, entryOf: () => GRANTED, sessionIdOf: () => 'main-thread', allows: subagentAllows, cred: CRED,
      dispatch: async (intent, opts) => { seen.push(opts.fromLabel); },
    });
    const r = await handle({ intent: line, agentId: 'agent-7' }, { closed: () => false });
    if (allowed) {
      assert.strictEqual(r.ok, true);
      assert.deepStrictEqual(seen, ['h1/agent']);
    } else {
      assert.deepStrictEqual(r, { ok: false, status: 'refused', error: `not available to a subagent: ${label} — return and let the seat's main agent do it` });
      assert.deepStrictEqual(seen, [], 'a refusal dispatches nothing');
    }
    const main = await handle({ intent: line, ident: identToken(crypto, CRED, null, null, 'main-thread') }, { closed: () => false });
    assert.strictEqual(main.ok, true, 'a verified main stamp: the seat\'s full catalog');
  });
}

function seatHarness({ realDeliver = false } = {}) {
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
    peerStatusLabel: require('../proxy-util').peerStatusLabel,
    shouldHoldDm: require('../proxy-util').shouldHoldDm,
    parseIntent: require('../intent-scanner').parseIntent,
    looksLikeIntent: require('../intent-scanner').looksLikeIntent,
    execBodyCap: 64 * 1024,
    isFilenameToken: require('../exec-schema').isFilenameToken,
    parseAndValidate: require('../exec-schema').parseAndValidate,
    getPersistence: () => ({ list: () => [], get: (n) => entries[n] || null }),
  });
  m._broadcast = (...a) => broadcasts.push(JSON.stringify(a));
  m._injectHoldReason = () => null;
  m._injectQueueFor = (s) => ({ enqueue: (t, o) => injected.push({ to: s.name, text: o && o.produce ? o.produce() : t }) });
  if (!realDeliver) m._gatedDeliver = (target, tag, body) => { delivered.push({ target, tag, body }); return { queued: true }; };
  const a = { name: 'a', agentType: 'claude', type: 'claude', io: 'pty', workspaceId: 'ws1', sessionId: 'sess-a' };
  const b = { name: 'b', agentType: 'claude', type: 'claude', io: 'pty', workspaceId: 'ws1', activityState: 'working', activityTs: Date.now() };
  m.sessions.set('a', a);
  m.sessions.set('b', b);
  return { m, root, a, b, logs, broadcasts, injected, delivered };
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

function mainEnv(cred, sessionId = 'sess-a') {
  return { CLODEX_HOOK_IDENT: identToken(crypto, cred, null, null, sessionId) };
}

async function withSeat(fn, opts) {
  const h = seatHarness(opts);
  fs.mkdirSync(runDirFor(h.root, 'a'), { recursive: true });
  const cred = mintIntentCredential(crypto);
  await h.m._startIntentSocket(h.a, { sockPath: pathFor(h.root, 'a', 'intentSocket'), cred });
  try { await fn(h, cred); } finally { h.a.intentSocket.stop(); }
}

test('reply capture: who returns the roster line to the caller and injects nothing into the seat', async () => {
  await withSeat(async (h, cred) => {
    const r = await viaVerb(h, cred, ['[agent:who]'], mainEnv(cred));
    assert.strictEqual(r.code, 0, r.err);
    assert.match(r.out, /^\[agent:peers\] b\b/);
    assert.deepStrictEqual(h.injected, [], 'the acknowledgement went to the socket, not the PTY');
    const n = await viaVerb(h, cred, ['[agent:name]'], { ...mainEnv(cred), CODEX_THREAD_ID: 'thread-9' });
    assert.strictEqual(n.out, '[agent:name] a\n');
    assert.deepStrictEqual(h.injected, []);
  });
});

test('an async verb says where its answer arrives for the main agent; a subagent dm is refused', async () => {
  await withSeat(async (h, cred) => {
    const r = await viaVerb(h, cred, ['[agent:dm', 'b]', 'which', 'file'], { CLODEX_AGENT_ID: 'agent-7' });
    assert.strictEqual(r.code, verb.EXIT.DENIED);
    assert.strictEqual(r.err, "clodex: not available to a subagent: dm — return and let the seat's main agent do it\n");
    assert.deepStrictEqual(h.delivered, []);
    const main = await viaVerb(h, cred, ['[agent:dm b] hi'], mainEnv(cred));
    assert.strictEqual(main.code, 0);
    assert.strictEqual(main.out, "sent to b; a reply arrives in the seat's main conversation\n");
    assert.strictEqual(h.delivered[0].tag, 'a', 'the main agent still sends as the seat');
    assert.deepStrictEqual(h.injected, []);
  });
});

test('a subagent is refused a lead verb with exit 3, and the main agent is not', async () => {
  await withSeat(async (h, cred) => {
    const r = await viaVerb(h, cred, ['[agent:shout] approve?'], { CLODEX_AGENT_ID: 'agent-7' });
    assert.strictEqual(r.code, verb.EXIT.DENIED);
    assert.strictEqual(r.err, "clodex: not available to a subagent: shout — return and let the seat's main agent do it\n");
    const g = await viaVerb(h, cred, ['[agent:exec clodex-team] {}'], { CLODEX_AGENT_ID: 'agent-7' });
    assert.strictEqual(g.code, verb.EXIT.DENIED);
    const granted = await viaVerb(h, cred, ['[agent:exec clodex-run-tests] {}'], { CLODEX_AGENT_ID: 'agent-7' });
    assert.strictEqual(granted.code, verb.EXIT.DENIED);
    const bad = await viaVerb(h, 'e'.repeat(64), ['[agent:who]']);
    assert.strictEqual(bad.code, verb.EXIT.DENIED);
    assert.strictEqual(bad.err, 'clodex: unauthorized\n');
  });
});

test('the seat credential appears in no log line and no ipc broadcast', async () => {
  await withSeat(async (h, cred) => {
    await viaVerb(h, cred, ['[agent:who]'], mainEnv(cred));
    await viaVerb(h, cred, ['[agent:dm b] x'], { CLODEX_AGENT_ID: 'agent-7' });
    await viaVerb(h, cred, ['[agent:dm b] x'], mainEnv(cred));
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

test('a subagent dm is refused before delivery', async () => {
  await withSeat(async (h, cred) => {
    h.a.activityState = 'working';
    h.a.activityTs = Date.now();
    const r = await viaVerb(h, cred, ['[agent:dm b] which file holds the pin'], { CLODEX_AGENT_ID: 'agent-7' });
    assert.strictEqual(r.code, verb.EXIT.DENIED);
    await new Promise((res) => setImmediate(res));
    assert.ok(!h.injected.some((i) => /\[agent:from a\/agent\]/.test(i.text)), JSON.stringify(h.injected));
  }, { realDeliver: true });
});

test('a Codex main thread whose id is the rollout uuid tail keeps the full catalog', async () => {
  const uuid = '0199aaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const seen = [];
  const handle = createIntentRequestHandler({
    seat: 'cx', parse, isCodex: true, entryOf: () => ({ type: 'codex' }), sessionIdOf: () => `rollout-2026-10-05T01-00-00-${uuid}`, allows: subagentAllows,
    dispatch: async (intent, opts) => { seen.push(opts.fromLabel); },
  });
  const main = await handle({ intent: '[agent:shout] x', agentId: uuid }, { closed: () => false });
  assert.strictEqual(main.ok, true, 'CODEX_THREAD_ID of the main thread is the main agent');
  assert.deepStrictEqual(seen, [null], 'and its dm would go out as the seat');
  const sub = await handle({ intent: '[agent:shout] x', agentId: '0199ffff-bbbb-cccc-dddd-eeeeeeeeeeee' }, { closed: () => false });
  assert.deepStrictEqual(sub, { ok: false, status: 'refused', error: "not available to a subagent: shout — return and let the seat's main agent do it" });
});

test('a Codex clone (no persistence entry) keeps its main thread: isCodex comes from the session, not entryOf', async () => {
  const uuid = '0199aaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const handle = createIntentRequestHandler({
    seat: 'cx', parse, isCodex: true, entryOf: () => undefined, sessionIdOf: () => `rollout-2026-10-05T01-00-00-${uuid}`, allows: subagentAllows,
    dispatch: async () => {},
  });
  assert.strictEqual((await handle({ intent: '[agent:shout] x', agentId: uuid }, { closed: () => false })).ok, true);
  const sub = await handle({ intent: '[agent:shout] x', agentId: '0199ffff-bbbb-cccc-dddd-eeeeeeeeeeee' }, { closed: () => false });
  assert.strictEqual(sub.status, 'refused');
});

test('_startIntentSocket marks a codex session as Codex even with no persistence entry', async () => {
  const uuid = '0199aaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const h = seatHarness();
  h.a.agentType = 'codex';
  h.a.type = 'codex';
  h.a.sessionId = `rollout-2026-10-05T01-00-00-${uuid}`;
  fs.mkdirSync(runDirFor(h.root, 'a'), { recursive: true });
  const cred = mintIntentCredential(crypto);
  await h.m._startIntentSocket(h.a, { sockPath: pathFor(h.root, 'a', 'intentSocket'), cred });
  try {
    const main = await viaVerb(h, cred, ['[agent:dm b] hi'], { CODEX_THREAD_ID: uuid });
    assert.strictEqual(main.code, 0, main.err);
    assert.deepStrictEqual(h.delivered, [{ target: 'b', tag: 'a', body: 'hi' }]);
  } finally { h.a.intentSocket.stop(); }
});

test('a Codex seat with no session id yet treats every caller as a subagent', async () => {
  const uuid = '0199aaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  for (const sid of [null, undefined]) {
    const handle = createIntentRequestHandler({
      seat: 'cx', parse, isCodex: true, entryOf: () => ({ type: 'codex' }), sessionIdOf: () => sid, allows: subagentAllows,
      dispatch: async () => {},
    });
    for (const r of [{ intent: '[agent:shout] x', agentId: uuid }, { intent: '[agent:shout] x' }]) {
      assert.deepStrictEqual(await handle(r, { closed: () => false }), { ok: false, status: 'refused', error: "not available to a subagent: shout — return and let the seat's main agent do it" });
    }
  }
});

test('the Codex uuid-tail match needs a uuid-shaped agent id', () => {
  assert.strictEqual(isMainThread('0199aaaa-bbbb-cccc-dddd-eeeeeeeeeeee', 'rollout-x-0199aaaa-bbbb-cccc-dddd-eeeeeeeeeeee'), true);
  assert.strictEqual(isMainThread('eeeeeeeeeeee', 'rollout-x-0199aaaa-bbbb-cccc-dddd-eeeeeeeeeeee'), false);
  assert.strictEqual(isMainThread('dddd-eeeeeeeeeeee', 'rollout-x-0199aaaa-bbbb-cccc-dddd-eeeeeeeeeeee'), false);
  assert.strictEqual(isMainThread('main-thread', 'main-thread'), true, 'an exact match needs no shape');
});

test('a Claude seat: only a main stamp keyed by this seat\'s credential and session is the main agent', async () => {
  const seen = [];
  const handle = createIntentRequestHandler({
    seat: 'h1', parse, entryOf: () => ({ type: 'claude' }), sessionIdOf: () => 'sess-1', allows: subagentAllows, cred: CRED,
    dispatch: async (intent, opts) => { seen.push(opts.fromLabel); },
  });
  const ctl = { closed: () => false };
  const refused = { ok: false, status: 'refused', error: "not available to a subagent: shout — return and let the seat's main agent do it" };
  assert.deepStrictEqual(await handle({ intent: '[agent:shout] x' }, ctl), refused, 'no stamp');
  assert.deepStrictEqual(await handle({ intent: '[agent:shout] x', agentId: 'sess-1' }, ctl), refused, 'an agentId claim is not a stamp');
  assert.deepStrictEqual(await handle({ intent: '[agent:shout] x', ident: identToken(crypto, 'd'.repeat(64), null, null, 'sess-1') }, ctl), refused, 'wrong cred');
  assert.deepStrictEqual(await handle({ intent: '[agent:shout] x', ident: identToken(crypto, CRED, null, null, 'sess-0') }, ctl), refused, 'another session');
  assert.deepStrictEqual(await handle({ intent: '[agent:shout] x', ident: 'main.deadbeefdeadbeef' }, ctl), refused, 'forged');
  assert.deepStrictEqual(await handle({ intent: '[agent:shout] x', ident: identToken(crypto, CRED, 'ag1', 'gp', 'sess-1') }, ctl), refused, 'a sub stamp');
  assert.deepStrictEqual(seen, []);
  const ok = await handle({ intent: '[agent:shout] x', ident: identToken(crypto, CRED, null, null, 'sess-1') }, ctl);
  assert.deepStrictEqual(ok.ok, true);
  assert.deepStrictEqual(seen, [null], 'the main agent acts as the seat');
});

function stampHarness({ sessionId = 'sess-1', now = () => 1000 } = {}) {
  const warns = [];
  const seen = [];
  const identSeen = new Map();
  const handle = createIntentRequestHandler({
    seat: 'h1', parse, entryOf: () => ({ type: 'claude' }), sessionIdOf: () => sessionId, allows: subagentAllows, cred: CRED,
    dispatch: async (intent, opts) => { seen.push(opts.fromLabel); },
    log: { warn: (tag, msg) => warns.push(`${tag}: ${msg}`) }, identSeen, now,
  });
  const shout = async (ident) => (await handle({ intent: '[agent:shout] x', ident }, { closed: () => false })).ok;
  return { shout, warns, seen, identSeen };
}

test('identity stamp: a fresh valid main stamp is the main agent', async () => {
  const h = stampHarness();
  assert.strictEqual(await h.shout(identToken(crypto, CRED, null, null, 'sess-1')), true);
  assert.deepStrictEqual(h.seen, [null]);
  assert.deepStrictEqual(h.warns, []);
});

test('identity stamp: the same stamp twice — the replay is a subagent and is logged', async () => {
  const h = stampHarness();
  const stamp = identToken(crypto, CRED, null, null, 'sess-1');
  assert.strictEqual(await h.shout(stamp), true);
  assert.strictEqual(await h.shout(stamp), false);
  assert.deepStrictEqual(h.seen, [null]);
  assert.deepStrictEqual(h.warns, ['intent-socket: h1: replayed identity stamp refused']);
});

test('identity stamp: two different stamps from the same session are both the main agent', async () => {
  const h = stampHarness();
  assert.strictEqual(await h.shout(identToken(crypto, CRED, null, null, 'sess-1')), true);
  assert.strictEqual(await h.shout(identToken(crypto, CRED, null, null, 'sess-1')), true);
  assert.deepStrictEqual(h.seen, [null, null]);
});

test('identity stamp: the old per-session shape main.<mac> is a subagent even when its mac is right', async () => {
  const h = stampHarness();
  const oldMac = crypto.createHmac('sha256', CRED).update('mainsess-1').digest('hex').slice(0, 16);
  assert.strictEqual(await h.shout(`main.${oldMac}`), false);
  const fresh = identToken(crypto, CRED, null, null, 'sess-1');
  assert.strictEqual(await h.shout(fresh.replace(/^main\.[0-9a-f]{16}\./, 'main.')), false, 'the mac without its nonce');
  assert.deepStrictEqual(h.seen, []);
});

test('identity stamp: the nonce set is capped FIFO at IDENT_SEEN_MAX and ages out after IDENT_SEEN_MS', async () => {
  let t = 1000;
  const h = stampHarness({ now: () => t });
  const stamps = [];
  for (let i = 0; i <= IDENT_SEEN_MAX; i++) stamps.push(identToken(crypto, CRED, null, null, 'sess-1'));
  for (const s of stamps) assert.strictEqual(await h.shout(s), true);
  assert.strictEqual(h.identSeen.size, IDENT_SEEN_MAX);
  assert.strictEqual(h.identSeen.has(stamps[0].split('.')[1]), false, 'the first nonce is forgotten');
  assert.strictEqual(await h.shout(stamps[IDENT_SEEN_MAX]), false, 'a replay inside the window is refused');
  t += IDENT_SEEN_MS;
  assert.strictEqual(await h.shout(identToken(crypto, CRED, null, null, 'sess-1')), true);
  assert.strictEqual(h.identSeen.size, 1, 'entries older than the window are dropped');
});

test('identity stamp: a Claude seat with no session id is a subagent even with a would-be-valid stamp', async () => {
  for (const sid of [null, '']) {
    const h = stampHarness({ sessionId: sid });
    for (const s of ['', 'null', 'undefined']) assert.strictEqual(await h.shout(identToken(crypto, CRED, null, null, s)), false, String(sid));
    assert.deepStrictEqual(h.seen, []);
  }
});

test('a client that hangs up before the reply closes the sink, so the late reply reaches the PTY', async () => {
  let captured = null;
  let arrived = null;
  const dispatched = new Promise((r) => { arrived = r; });
  let ctlRef = null;
  const inner = createIntentRequestHandler({
    seat: 'h1', parse, entryOf: () => ({}), sessionIdOf: () => null, allows: () => true,
    dispatch: async (intent, opts) => { captured = opts.replyTo; arrived(); },
    replyWaitMs: () => 60000,
    setTimer: () => 0, clearTimer: () => {},
  });
  const { srv, sockPath } = await server({
    handle: (r, ctl) => { ctlRef = ctl; return inner(r, ctl); },
    setTimer: () => 0, clearTimer: () => {},
  });
  try {
    const c = net.createConnection(sockPath);
    c.on('error', () => {});
    c.on('connect', () => c.write(req({ cred: CRED, intent: '[agent:who]' })));
    await dispatched;
    c.destroy();
    for (let i = 0; i < 500 && !ctlRef.closed(); i++) await new Promise((r) => setImmediate(r));
    assert.strictEqual(ctlRef.closed(), true, 'the server saw the hang-up');
    const pty = [];
    const inject = (t) => { if (captured(t) !== false) return; pty.push(t); };
    inject('[agent:browser] waited 60s');
    assert.deepStrictEqual(pty, ['[agent:browser] waited 60s']);
  } finally { srv.stop(); }
});

test('the socket writes the credential file 0600 beside it and removes it on stop', async () => {
  const root = mkTmpRoot('isock-');
  const sockPath = sockIn(root);
  const credPath = pathFor(root, 's1', 'intentCred');
  const srv = createIntentSocketServer({ net, fs, crypto, sockPath, cred: CRED, credPath, handle: async () => ({ ok: true }) });
  await srv.start();
  try {
    assert.strictEqual(fs.readFileSync(credPath, 'utf8'), CRED);
    assert.strictEqual(fs.statSync(credPath).mode & 0o777, 0o600);
  } finally { srv.stop(); }
  assert.strictEqual(fs.existsSync(credPath), false);
});

test('the reply sink closes when the reply is built, so a late acknowledgement falls through to the seat', async () => {
  let late = null;
  const handle = createIntentRequestHandler({
    seat: 'h1', parse, entryOf: () => ({}), sessionIdOf: () => null, allows: () => true,
    dispatch: async (intent, opts) => { opts.replyTo('now'); late = opts.replyTo; },
  });
  const r = await handle({ intent: '[agent:who]' }, { closed: () => false });
  assert.deepStrictEqual(r, { ok: true, status: 'ok', reply: 'now' });
  assert.strictEqual(late('later'), false, 'the late text goes to _injectText\'s normal path');
});

test('stamp: clodex behind a reserved word or a prefix command is stamped; clodex as an argument is not', () => {
  const T = 'CLODEX_HOOK_IDENT=t';
  for (const [cmd, want] of [
    ['if clodex x; then :; fi', `if ${T} clodex x; then :; fi`],
    ['if a; then clodex x; fi', `if a; then ${T} clodex x; fi`],
    ['if a; then b; else clodex x; fi', `if a; then b; else ${T} clodex x; fi`],
    ['if a; then b; elif clodex x; then c; fi', `if a; then b; elif ${T} clodex x; then c; fi`],
    ['for i in 1; do clodex x; done', `for i in 1; do ${T} clodex x; done`],
    ['while clodex x; do :; done', `while ${T} clodex x; do :; done`],
    ['until clodex x; do :; done', `until ${T} clodex x; do :; done`],
    ['! clodex x', `! ${T} clodex x`],
    ['{ clodex x; }', `{ ${T} clodex x; }`],
    ['(clodex x)', `(${T} clodex x)`],
    ['time clodex x', `time ${T} clodex x`],
    ['time -p clodex x', `time -p ${T} clodex x`],
    ['timeout 300 clodex x', `${T} timeout 300 clodex x`],
    ['timeout 1.5m clodex x', `${T} timeout 1.5m clodex x`],
    ['timeout -k 5 300 clodex x', `${T} timeout -k 5 300 clodex x`],
    ['timeout -s KILL 300 clodex x', `${T} timeout -s KILL 300 clodex x`],
    ['timeout --preserve-status 300 clodex x', `${T} timeout --preserve-status 300 clodex x`],
    ['nice -5 clodex x', `${T} nice -5 clodex x`],
    ['X=1 time clodex x', `${T} X=1 time clodex x`],
    ['timeout clodex x', null],
    ['nohup clodex x', `${T} nohup clodex x`],
    ['nice clodex x', `${T} nice clodex x`],
    ['nice -n 5 clodex x', `${T} nice -n 5 clodex x`],
    ['nice -n5 clodex x', `${T} nice -n5 clodex x`],
    ['env CLODEX_HOOK_IDENT=@ffffffffffffffff clodex x', `${T} env clodex x`],
    ["cat <<'EOF'\n(clodex 11:17)\nclodex at line start\nEOF", null],
    ['cat <<EOF\nclodex x\nEOF\nclodex y', `cat <<EOF\nclodex x\nEOF\n${T} clodex y`],
    ["clodex '[agent:dm x]' <<EOF\nclodex inside\nEOF", `${T} clodex '[agent:dm x]' <<EOF\nclodex inside\nEOF`],
    ['cat <<-EOF\n\tclodex x\n\tEOF\nclodex y', `cat <<-EOF\n\tclodex x\n\tEOF\n${T} clodex y`],
    ['cat <<A <<B\nclodex a\nA\nclodex b\nB', null],
    ['cat << "E O"\nclodex a\nE O\nclodex b', `cat << "E O"\nclodex a\nE O\n${T} clodex b`],
    ['cat <<EOF\nclodex a', null],
    ['cat <<< clodex\nclodex y', `cat <<< clodex\n${T} clodex y`],
    ["clodex - <<< '[agent:who]'\nclodex z", `${T} clodex - <<< '[agent:who]'\n${T} clodex z`],
    ['builtin command clodex x', `${T} builtin command clodex x`],
    ['exec clodex x', `${T} exec clodex x`],
    ['env FOO=1 clodex x', `${T} env FOO=1 clodex x`],
    ["cd x && timeout 300 clodex '[agent:name]' | head", `cd x && ${T} timeout 300 clodex '[agent:name]' | head`],
    ['if CLODEX_HOOK_IDENT=main.f clodex x; then :; fi', `if ${T} clodex x; then :; fi`],
    ['echo clodex', null],
    ['which clodex', null],
    ['grep clodex f', null],
  ]) {
    assert.strictEqual(stampClodexCommand(cmd, 't'), want, cmd);
  }
});
