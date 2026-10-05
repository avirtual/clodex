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
const { mintIntentCredential, seatChannelEnv, createIntentRequestHandler } = require('../intent-socket');
const verb = require('../cli/bin/clodex.js');

function parse(text) {
  return scanIntentLines(text.split('\n'), {}).filter((s) => s.kind === 'intent').map((s) => s.intent);
}

function withBrowserVerb(fn) {
  registry.registerIntent({ verb: 'browser', parse: grammar.parseLine, handler: () => {} }, 'browser-pane', { shipped: true });
  return Promise.resolve().then(fn).finally(() => registry._resetPluginRows());
}

const SEAT = { intents: ['browser'], plugins: ['browser-pane'] };
const ctl = { closed: () => false };

function browserHandler(entry = SEAT) {
  const seen = [];
  const handle = createIntentRequestHandler({
    seat: 'h1', parse, entryOf: () => entry, sessionIdOf: () => 'main-thread',
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
  ['wait ebloc', true],
  ['download ebloc 7', true],
  ['screenshot ebloc', true],
  ['inspect ebloc 2', true],
  ['services', true],
  ['release ebloc', false],
];

for (const [args, allowed] of BROWSER_TABLE) {
  test(`subagent browser ${args.split(' ')[0]} is ${allowed ? 'allowed' : 'refused'}`, () => withBrowserVerb(async () => {
    const { handle, seen } = browserHandler();
    const r = await handle({ intent: `[agent:browser ${args}]`, agentId: 'agent-7' }, ctl);
    if (allowed) {
      assert.deepStrictEqual(r, { ok: true, reply: 'ok' });
      assert.deepStrictEqual(seen, [args]);
    } else {
      assert.deepStrictEqual(r, { ok: false, error: "release is for the seat's main agent" });
      assert.deepStrictEqual(seen, []);
    }
  }));
}

test('subagent browser is refused when the seat lacks the plugin, and when no plugin registered the verb', () => withBrowserVerb(async () => {
  const noPlugin = browserHandler({ intents: ['browser'], plugins: [] });
  const r = await noPlugin.handle({ intent: '[agent:browser read ebloc]', agentId: 'agent-7' }, ctl);
  assert.deepStrictEqual(r, { ok: false, error: 'not available to a subagent: browser' });
  assert.deepStrictEqual(noPlugin.seen, []);
  assert.strictEqual(registry.subagentAllows({ type: 'browser', raw: 'read ebloc' }, SEAT), true);
  registry._resetPluginRows();
  assert.strictEqual(registry.subagentAllows({ type: 'browser', raw: 'read ebloc' }, SEAT), false);
}));

test('a subagent cannot --confirm a consequential action; the main agent can', () => withBrowserVerb(async () => {
  const { handle, seen } = browserHandler();
  for (const sub of ['click ebloc 26', 'type ebloc 3', 'select ebloc 4', 'key ebloc Enter']) {
    const r = await handle({ intent: `[agent:browser ${sub} --confirm]`, agentId: 'agent-7' }, ctl);
    assert.deepStrictEqual(r, { ok: false, error: 'a subagent cannot confirm a consequential action — ask the main agent' });
  }
  assert.deepStrictEqual(seen, []);
  const main = await handle({ intent: '[agent:browser click ebloc 26 --confirm]' }, ctl);
  assert.deepStrictEqual(main, { ok: true, reply: 'ok' });
  assert.deepStrictEqual(seen, ['click ebloc 26 --confirm']);
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
  assert.deepStrictEqual(await pending, { ok: true, reply: "who accepted; its reply will arrive in the seat's main conversation" });
  assert.strictEqual(late('later'), false, 'the late line goes to the seat');
});

function seatHarness() {
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
    handler: (handle, intent) => { handled.push({ handle, raw: intent.raw }); if (arrived) arrived(); },
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

async function withSeat(fn) {
  const h = seatHarness();
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

for (const [who, env] of [['a subagent', { CLODEX_AGENT_ID: 'agent-7' }], ['the main agent', {}]]) {
  test(`${who}: a plugin reply injected later, outside the call's async context, is the tool result and never reaches the PTY`, async () => {
    await withSeat(async (h, cred) => {
      const call = viaVerb(h, cred, ['[agent:browser read one]'], env);
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
