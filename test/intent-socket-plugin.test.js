'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { mkTmpRoot } = require('./lib/tmp-roots');
const { mk } = require('./lib/session-fixtures');
const { pathFor, runDirFor } = require('../clodex-paths');
const { scanIntentLines } = require('../intent-segments');
const registry = require('../intent-registry');
const grammar = require('../plugins/browser-pane/grammar');
const replies = require('../plugins/browser-pane/replies');
const subagent = require('../plugins/browser-pane/subagent');
const { TOOL } = require('../plugins/browser-pane/mcp-tool');
const { mintIntentCredential, seatChannelEnv, createIntentRequestHandler, identToken } = require('../intent-socket');
const verb = require('../cli/bin/clodex.js');

function parse(text) {
  return scanIntentLines(text.split('\n'), {}).filter((s) => s.kind === 'intent').map((s) => s.intent);
}

function withBrowserVerb(fn) {
  registry.registerIntent({ verb: 'browser', parse: grammar.parseLine, handler: () => {}, tools: [TOOL], subagent }, 'browser-pane', { shipped: true });
  return Promise.resolve().then(fn).finally(() => registry._resetPluginRows());
}

const SEAT = { intents: ['browser'], plugins: ['browser-pane'] };
const ctl = { closed: () => false };
const HCRED = 'h'.repeat(64);
const MAIN = identToken(crypto, HCRED, null, null, 'main-thread');

function browserHandler(entry = SEAT) {
  const seen = [];
  const handle = createIntentRequestHandler({
    seat: 'h1', parse, entryOf: () => entry, sessionIdOf: () => 'main-thread', cred: HCRED,
    refusal: registry.subagentRefusal,
    dispatch: async (intent, opts) => { seen.push(intent.raw); opts.replyTo('ok'); },
  });
  return { handle, seen };
}

const BROWSER_TABLE = [
  ['open ebloc', true],
  ['read ebloc', true],
  ['click ebloc 26', true],
  ['type ebloc 3', true],
  ['select ebloc 4', true],
  ['key ebloc Enter', true],
  ['scroll ebloc down', true],
  ['wait ebloc', true],
  ['download ebloc 7', true],
  ['screenshot ebloc', true],
  ['inspect ebloc 2', true],
  ['services', true],
  ['note ebloc --list', true],
  ['release ebloc', false],
];

for (const [args, allowed] of BROWSER_TABLE) {
  test(`subagent browser ${args.split(' ')[0]} is ${allowed ? 'allowed' : 'refused'}`, () => withBrowserVerb(async () => {
    const { handle, seen } = browserHandler();
    const r = await handle({ intent: `[agent:browser ${args}]`, agentId: 'agent-7' }, ctl);
    if (allowed) {
      assert.deepStrictEqual(r, { ok: true, status: 'ok', reply: 'ok' });
      assert.deepStrictEqual(seen, [args]);
    } else {
      assert.deepStrictEqual(r, { ok: false, status: 'refused', error: "release is for the seat's main agent" });
      assert.deepStrictEqual(seen, []);
    }
  }));
}

test('the subagent catalog is the granted rows with tools', () => withBrowserVerb(() => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'intent-registry.js'), 'utf8');
  assert.ok(!src.includes('SUBAGENT_SUBS'));
  assert.ok(!src.includes("'browser'"));
  assert.deepStrictEqual(registry.subagentCatalogFor(SEAT), { tools: [{ name: 'browser', description: TOOL.description, inputSchema: TOOL.inputSchema }], briefs: [subagent.brief] });
  assert.deepStrictEqual(registry.subagentCatalogFor({ intents: ['browser'], plugins: [] }), { tools: [], briefs: [] });
  registry._resetPluginRows();
  assert.deepStrictEqual(registry.subagentCatalogFor(SEAT), { tools: [], briefs: [] });
}));

test('a plugin row without a subagent policy refuses every subagent call with the generic text', async () => {
  registry.registerIntent({ verb: 'zzz', parse: (s) => ({ raw: s }), handler() {} }, 'zzz-plugin');
  try {
    const { handle, seen } = browserHandler({ intents: ['zzz'], plugins: ['zzz-plugin'] });
    const r = await handle({ intent: '[agent:zzz anything]', agentId: 'agent-7' }, ctl);
    assert.deepStrictEqual(r, { ok: false, status: 'refused', error: "not available to a subagent: zzz — return and let the seat's main agent do it" });
    assert.deepStrictEqual(seen, []);
    const main = await handle({ intent: '[agent:zzz anything]', ident: MAIN }, ctl);
    assert.deepStrictEqual(main, { ok: true, status: 'ok', reply: 'ok' });
    assert.deepStrictEqual(seen, ['anything']);
  } finally {
    registry._resetPluginRows();
  }
});

test('a refuse() that throws is a generic refusal, never an allow', () => {
  registry.registerIntent({ verb: 'zzz', parse: (s) => ({ raw: s }), handler() {}, subagent: { refuse() { throw new Error('boom'); }, brief: 'z' } }, 'zzz-plugin');
  try {
    assert.strictEqual(registry.subagentRefusal({ type: 'zzz', raw: 'anything' }, { intents: ['zzz'], plugins: ['zzz-plugin'] }), '');
  } finally {
    registry._resetPluginRows();
  }
});

test('subagent browser close is refused naming the verb; a word that is no verb keeps the generic label', () => withBrowserVerb(async () => {
  const { handle, seen } = browserHandler();
  const r = await handle({ intent: '[agent:browser close ebloc]', agentId: 'agent-7' }, ctl);
  assert.deepStrictEqual(r, { ok: false, status: 'refused', error: 'not available to a subagent: browser close (a subagent may open, read, click, type, select, key, scroll, back, forward, wait, download, screenshot, inspect, services, note)' });
  const odd = await handle({ intent: '[agent:browser frobnicate ebloc]', agentId: 'agent-7' }, ctl);
  assert.deepStrictEqual(odd, { ok: false, status: 'refused', error: "not available to a subagent: browser — return and let the seat's main agent do it" });
  assert.deepStrictEqual(seen, []);
}));

test('subagent browser is refused when the seat lacks the plugin, and when no plugin registered the verb', () => withBrowserVerb(async () => {
  const noPlugin = browserHandler({ intents: ['browser'], plugins: [] });
  const r = await noPlugin.handle({ intent: '[agent:browser read ebloc]', agentId: 'agent-7' }, ctl);
  assert.deepStrictEqual(r, { ok: false, status: 'refused', error: "not available to a subagent: browser — return and let the seat's main agent do it" });
  assert.deepStrictEqual(noPlugin.seen, []);
  assert.strictEqual(registry.subagentAllows({ type: 'browser', raw: 'read ebloc' }, SEAT), true);
  registry._resetPluginRows();
  assert.strictEqual(registry.subagentAllows({ type: 'browser', raw: 'read ebloc' }, SEAT), false);
}));

test('a subagent cannot --confirm a consequential action; the main agent can', () => withBrowserVerb(async () => {
  const { handle, seen } = browserHandler();
  for (const sub of ['click ebloc 26', 'type ebloc 3', 'select ebloc 4', 'key ebloc Enter']) {
    const r = await handle({ intent: `[agent:browser ${sub} --confirm]`, agentId: 'agent-7' }, ctl);
    assert.deepStrictEqual(r, { ok: false, status: 'refused', error: 'a subagent cannot confirm a consequential action — ask the main agent' });
  }
  for (const intent of ['[agent:browser type ebloc 3 --confirm --enter] hi', '[agent:browser key ebloc --confirm] Enter']) {
    const r = await handle({ intent, agentId: 'agent-7' }, ctl);
    assert.deepStrictEqual(r, { ok: false, status: 'refused', error: 'a subagent cannot confirm a consequential action — ask the main agent' }, intent);
  }
  for (const flag of ['"--confirm"', '--con"firm"']) {
    assert.strictEqual(grammar.toCommand({ raw: `click ebloc 26 ${flag}` }).confirm, true, `the grammar reads ${flag} as --confirm`);
    const r = await handle({ intent: `[agent:browser click ebloc 26 ${flag}]`, agentId: 'agent-7' }, ctl);
    assert.deepStrictEqual(r, { ok: false, status: 'refused', error: 'a subagent cannot confirm a consequential action — ask the main agent' }, flag);
  }
  assert.deepStrictEqual(seen, []);
  const main = await handle({ intent: '[agent:browser click ebloc 26 --confirm]', ident: MAIN }, ctl);
  assert.deepStrictEqual(main, { ok: true, status: 'ok', reply: 'ok' });
  assert.deepStrictEqual(seen, ['click ebloc 26 --confirm']);
}));

test('a subagent may add and list site notes but not --forget one; the main agent can', () => withBrowserVerb(async () => {
  const { handle, seen } = browserHandler();
  assert.deepStrictEqual(subagent.SUBS.includes('note'), true);
  const add = await handle({ intent: '[agent:browser note ebloc] @/facturi path: Facturi first', agentId: 'agent-7' }, ctl);
  assert.deepStrictEqual(add, { ok: true, status: 'ok', reply: 'ok' });
  for (const intent of ['[agent:browser note ebloc --forget ab3k]', '[agent:browser note ebloc --forget=ab3k]']) {
    const r = await handle({ intent, agentId: 'agent-7' }, ctl);
    assert.deepStrictEqual(r, { ok: false, status: 'refused', error: 'a subagent cannot forget a site note — ask the main agent' }, intent);
  }
  assert.deepStrictEqual(seen, ['note ebloc']);
  const main = await handle({ intent: '[agent:browser note ebloc --forget ab3k]', ident: MAIN }, ctl);
  assert.deepStrictEqual(main, { ok: true, status: 'ok', reply: 'ok' });
  assert.deepStrictEqual(seen, ['note ebloc', 'note ebloc --forget ab3k']);
}));

test('a plugin that never replies: the deadline answers "accepted", and a late line falls through', async () => {
  const timers = [];
  let late = null;
  let extended = null;
  const handle = createIntentRequestHandler({
    seat: 'h1', parse, entryOf: () => ({}), sessionIdOf: () => null, allows: () => true,
    dispatch: async (intent, opts) => { late = opts.replyTo; },
    replyWaitMs: () => 25000,
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimer: () => {},
  });
  const pending = handle({ intent: '[agent:who]' }, { closed: () => false, extend: (ms) => { extended = ms; } });
  for (let i = 0; i < 5 && !timers.length; i++) await new Promise((r) => setImmediate(r));
  assert.strictEqual(timers[0].ms, 25000);
  assert.ok(extended > 25000, 'the socket timer outlives the plugin deadline');
  timers[0].fn();
  assert.deepStrictEqual(await pending, { ok: true, status: 'ok', reply: "who accepted; its reply will arrive in the seat's main conversation" });
  assert.strictEqual(late('later'), false, 'the late line goes to the seat');
});

function seatHarness({ handler = null } = {}) {
  const root = mkTmpRoot('isock-sm-');
  const injected = [];
  const handled = [];
  let arrived = null;
  const entries = { a: { intents: ['browser', 'who'], plugins: ['browser-pane'] } };
  const logger = {};
  for (const k of ['info', 'debug', 'warn', 'error']) logger[k] = () => {};
  const m = mk({
    REGISTRY_DIR: root,
    MSG_DIR: path.join(root, 'messages'),
    PENDING_DIR: path.join(root, 'pending'),
    pathFor,
    runDirFor,
    log: logger,
    registry: { listPeers: async () => [], getPeer: async () => null, register: () => {}, unregister: () => {} },
    getPeerManager: () => null,
    parseIntent: require('../intent-scanner').parseIntent,
    looksLikeIntent: require('../intent-scanner').looksLikeIntent,
    getPersistence: () => ({ list: () => [], get: (n) => entries[n] || null }),
    getPluginHooks: () => ({
      handleFor: (name) => {
        const s = m.sessions.get(name);
        return Object.freeze({
          name,
          inject: (text) => m._injectText(s, String(text), { parkable: true, ownScope: true }),
        });
      },
    }),
  });
  m._injectHoldReason = () => null;
  m._injectQueueFor = (s) => ({ enqueue: (t, o) => injected.push({ to: s.name, text: o && o.produce ? o.produce() : t }) });
  const a = { name: 'a', agentType: 'claude', type: 'claude', io: 'pty', workspaceId: 'ws1', sessionId: 'sess-a' };
  m.sessions.set('a', a);
  registry.registerIntent({
    verb: 'browser',
    parse: grammar.parseLine,
    handler: (handle, intent) => { handled.push({ handle, raw: intent.raw }); if (arrived) arrived(); if (handler) handler(handle, intent); },
    classifyReply: replies.classifyReply,
  }, 'browser-pane', { shipped: true });
  const nextHandled = (n) => new Promise((resolve) => {
    arrived = () => { if (handled.length >= n) resolve(); };
    arrived();
  });
  return { m, root, a, injected, handled, nextHandled };
}

async function turns(n) {
  for (let i = 0; i < n; i++) await new Promise((resolve) => setImmediate(resolve));
}

async function withSeat(fn, opts) {
  const h = seatHarness(opts);
  fs.mkdirSync(runDirFor(h.root, 'a'), { recursive: true });
  const cred = mintIntentCredential(crypto);
  await h.m._startIntentSocket(h.a, { sockPath: pathFor(h.root, 'a', 'intentSocket'), cred });
  try { await fn(h, cred); } finally { h.a.intentSocket.stop(); registry._resetPluginRows(); }
}

async function viaVerb(h, cred, argv, extraEnv = {}) {
  let out = '';
  let err = '';
  const env = { ...seatChannelEnv({ name: 'a', sockPath: pathFor(h.root, 'a', 'intentSocket'), cred }), ...extraEnv };
  const code = await verb.main(argv, { env, out: { write: (t) => { out += t; } }, err: { write: (t) => { err += t; } } });
  return { code, out, err };
}

function mainStamp(cred, sessionId = 'sess-a') {
  return { CLODEX_HOOK_IDENT: identToken(crypto, cred, null, null, sessionId) };
}

for (const [who, envOf] of [['a subagent', () => ({ CLODEX_AGENT_ID: 'agent-7' })], ['the main agent', mainStamp]]) {
  test(`${who}: a plugin reply injected later, outside the call's async context, is the tool result and never reaches the PTY`, async () => {
    await withSeat(async (h, cred) => {
      const call = viaVerb(h, cred, ['[agent:browser read one]'], envOf(cred));
      await h.nextHandled(1);
      await turns(10);
      h.handled[0].handle.inject('[agent:browser] read one → @/tmp/r-0001.txt');
      const r = await call;
      assert.strictEqual(r.code, 0, r.err);
      assert.strictEqual(r.out, '[agent:browser] read one → @/tmp/r-0001.txt\n');
      assert.deepStrictEqual(h.injected, []);
      h.handled[0].handle.inject('[agent:browser] a second line after the reply');
      assert.deepStrictEqual(h.injected.map((i) => i.text), ['[agent:browser] a second line after the reply'], 'once the call answered, its handle falls through to the seat');
    });
  });
}

test('two concurrent plugin calls on one seat each get their own reply', async () => {
  await withSeat(async (h, cred) => {
    const env = { CLODEX_AGENT_ID: 'agent-7' };
    const one = viaVerb(h, cred, ['[agent:browser read one]'], env);
    const two = viaVerb(h, cred, ['[agent:browser read two]'], { CLODEX_AGENT_ID: 'agent-8' });
    await h.nextHandled(2);
    await turns(10);
    const by = Object.fromEntries(h.handled.map((x) => [x.raw, x.handle]));
    by['read two'].inject('reply two');
    by['read one'].inject('reply one');
    const [r1, r2] = await Promise.all([one, two]);
    assert.strictEqual(r1.out, 'reply one\n');
    assert.strictEqual(r2.out, 'reply two\n');
    assert.deepStrictEqual(h.injected, []);
  });
});

test('the plugin handle carries from: <seat>/agent for a subagent, the seat for the main agent, nothing outside a call', async () => {
  await withSeat(async (h, cred) => {
    const sub = viaVerb(h, cred, ['[agent:browser read one]'], { CLODEX_AGENT_ID: 'agent-7' });
    await h.nextHandled(1);
    await turns(10);
    assert.strictEqual(h.handled[0].handle.from, 'a/agent');
    h.handled[0].handle.inject('reply one');
    await sub;
    const main = viaVerb(h, cred, ['[agent:browser read two]'], mainStamp(cred));
    await h.nextHandled(2);
    await turns(10);
    assert.strictEqual(h.handled[1].handle.from, 'a');
    h.handled[1].handle.inject('reply two');
    await main;
    h.m._dispatchPluginIntent(h.a, { type: 'browser', raw: 'read three' });
    assert.strictEqual(h.handled[2].handle.from, undefined);
    assert.strictEqual(h.handled[2].handle.name, 'a');
  });
});

test('a Claude seat without the hook stamp: release and --confirm exit 3 and dispatch nothing, read goes through', async () => {
  await withSeat(async (h, cred) => {
    const rel = await viaVerb(h, cred, ['[agent:browser release one]']);
    assert.deepStrictEqual(rel, { code: verb.EXIT.DENIED, out: '', err: "clodex: release is for the seat's main agent\n" });
    const conf = await viaVerb(h, cred, ['[agent:browser click one 3 --confirm]']);
    assert.strictEqual(conf.code, verb.EXIT.DENIED);
    assert.strictEqual(conf.err, 'clodex: a subagent cannot confirm a consequential action — ask the main agent\n');
    for (const env of [mainStamp('e'.repeat(64)), mainStamp(cred, 'sess-other'), { CLODEX_HOOK_IDENT: 'main.deadbeefdeadbeef' }]) {
      const r = await viaVerb(h, cred, ['[agent:browser release one]'], env);
      assert.strictEqual(r.code, verb.EXIT.DENIED, env.CLODEX_HOOK_IDENT);
    }
    assert.deepStrictEqual(h.handled, [], 'no refused call reached the plugin');
    const read = viaVerb(h, cred, ['[agent:browser read one]']);
    await h.nextHandled(1);
    await turns(10);
    h.handled[0].handle.inject('[agent:browser] read one → @/tmp/r-0002.txt');
    assert.strictEqual((await read).code, 0);
  });
});

test('a verified main stamp releases the window', async () => {
  await withSeat(async (h, cred) => {
    const call = viaVerb(h, cred, ['[agent:browser release one]'], mainStamp(cred));
    await h.nextHandled(1);
    await turns(10);
    assert.deepStrictEqual(h.handled.map((x) => x.raw), ['release one']);
    h.handled[0].handle.inject(replies.reply('released one'));
    assert.deepStrictEqual(await call, { code: 0, out: '[agent:browser] released one\n', err: '' });
  });
});

test('a browser error reply exits 1 and a browser refusal exits 3, the text on stdout either way', async () => {
  await withSeat(async (h, cred) => {
    for (const [line, code, n] of [
      [replies.errorReply('x'), verb.EXIT.ERROR, 1],
      [replies.errorReply(replies.TEXT.consequential(3, 'Pay', 'payment')), verb.EXIT.DENIED, 2],
    ]) {
      const call = viaVerb(h, cred, ['[agent:browser click one 3]'], mainStamp(cred));
      await h.nextHandled(n);
      await turns(10);
      h.handled[n - 1].handle.inject(line);
      assert.deepStrictEqual(await call, { code, out: `${line}\n`, err: '' });
    }
  });
});

test('end to end: a caller that hangs up before the plugin replies: the reply lands at the seat PTY', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await withSeat(async (h, cred) => {
    const sock = require('node:net').createConnection(pathFor(h.root, 'a', 'intentSocket'));
    await new Promise((resolve) => sock.on('connect', resolve));
    sock.write(JSON.stringify({ cred, intent: '[agent:browser read one]', ident: mainStamp(cred).CLODEX_HOOK_IDENT }) + '\n');
    await h.nextHandled(1);
    assert.strictEqual(h.a.intentSocket.activeCount(), 1);
    sock.destroy();
    for (let i = 0; i < 1000 && h.a.intentSocket.activeCount() > 0; i++) await turns(1);
    assert.strictEqual(h.a.intentSocket.activeCount(), 0, 'the server saw the hang-up');
    h.handled[0].handle.inject('[agent:browser] read one → @/tmp/r-0003.txt');
    assert.deepStrictEqual(h.injected.map((i) => i.text), ['[agent:browser] read one → @/tmp/r-0003.txt']);
    t.mock.timers.tick(registry.PLUGIN_REPLY_WAIT_MAX_MS + 60 * 1000);
    await turns(10);
    assert.strictEqual(h.a.intentSocket.activeCount(), 0);
    assert.strictEqual(h.injected.length, 1, 'the expired wait adds nothing to the PTY');
  });
});

test('a plugin handler that throws answers the socket caller with an error status, and the CLI exits 1', async () => {
  await withSeat(async (h, cred) => {
    const sock = require('node:net').createConnection(pathFor(h.root, 'a', 'intentSocket'));
    await new Promise((resolve) => sock.on('connect', resolve));
    let buf = '';
    const res = new Promise((resolve) => sock.on('data', (d) => { buf += d; if (buf.includes('\n')) resolve(JSON.parse(buf)); }));
    sock.write(JSON.stringify({ cred, intent: '[agent:browser read one]', ident: mainStamp(cred).CLODEX_HOOK_IDENT }) + '\n');
    assert.deepStrictEqual(await res, { ok: true, status: 'error', reply: '[agent:browser] error: boom' });
    sock.destroy();
  }, { handler: () => { throw new Error('boom'); } });
});

test('a grammar hint thrown by the browser handler exits 1, the service-after-flag hint included', async () => {
  await withSeat(async (h, cred) => {
    for (const raw of ['[agent:browser read --filter=pdf t56]', '[agent:browser wait t56 --for=Interactive Brokers]']) {
      const r = await viaVerb(h, cred, [raw], mainStamp(cred));
      assert.strictEqual(r.code, verb.EXIT.ERROR, raw);
      assert.match(r.out, /^\[agent:browser\] error: unexpected /, raw);
    }
  }, { handler: (handle, intent) => grammar.toCommand(intent) });
});
