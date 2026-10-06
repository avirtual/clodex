'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { scanIntentLines } = require('../intent-segments');
const registry = require('../intent-registry');
const grammar = require('../plugins/browser-pane/grammar');
const subagent = require('../plugins/browser-pane/subagent');
const { TOOL } = require('../plugins/browser-pane/mcp-tool');
const { createIntentRequestHandler, identToken } = require('../intent-socket');

function parse(text) {
  return scanIntentLines(text.split('\n'), {}).filter((s) => s.kind === 'intent').map((s) => s.intent);
}

function withBrowserVerb(fn, tool = TOOL) {
  registry.registerIntent({ verb: 'browser', parse: grammar.parseLine, handler: () => {}, tools: [tool], subagent }, 'browser-pane', { shipped: true });
  return Promise.resolve().then(fn).finally(() => registry._resetPluginRows());
}

const SEAT = { intents: ['browser'], plugins: ['browser-pane'] };
const ctl = { closed: () => false };
const HCRED = 'h'.repeat(64);
const MAIN = identToken(crypto, HCRED, null, null, 'main-thread');
const TOOLS = { rowFor: registry.toolRowFor, intentFor: registry.toolIntentFor, enabled: registry.intentEnabledForSeat };
const warns = [];
const log = { warn: (tag, msg) => warns.push(`${tag} ${msg}`) };

function browserHandler(entry = SEAT, { tools = TOOLS } = {}) {
  const seen = [];
  const handle = createIntentRequestHandler({
    seat: 'h1', parse, entryOf: () => entry, sessionIdOf: () => 'main-thread', cred: HCRED, log,
    refusal: registry.subagentRefusal, tools,
    dispatch: async (intent, opts) => { seen.push(intent.raw); opts.replyTo('ok'); },
  });
  return { handle, seen };
}

const fakeTool = (name, extra = {}) => ({ name, description: 'd', inputSchema: { type: 'object' }, toIntent: () => '', ...extra });
const fakePolicy = { refuse: () => null, brief: 'b' };

test('a tool call and its intent form get the same reply and dispatch the same raw intent', () => withBrowserVerb(async () => {
  const table = [
    [{ verb: 'open', service: 'ebloc', body: 'https://x.test/' }, '[agent:browser open ebloc] https://x.test/'],
    [{ verb: 'read', service: 'ebloc' }, '[agent:browser read ebloc]'],
    [{ verb: 'click', service: 'ebloc', bracket: ['26'] }, '[agent:browser click ebloc 26]'],
    [{ verb: 'click', service: 'ebloc', bracket: ['--text=hi there'] }, '[agent:browser click ebloc --text="hi there"]'],
  ];
  for (const [args, intent] of table) {
    const { handle, seen } = browserHandler();
    const viaTool = await handle({ tool: 'browser', args }, ctl);
    const viaIntent = await handle({ intent }, ctl);
    assert.deepStrictEqual(viaTool, viaIntent, intent);
    assert.deepStrictEqual(viaTool, { ok: true, status: 'ok', reply: 'ok' });
    assert.strictEqual(seen.length, 2);
    assert.strictEqual(seen[0], seen[1], intent);
  }
}));

test('subagent policy applies through the mapper: --confirm and note --forget are refused like the intent form', () => withBrowserVerb(async () => {
  const { handle, seen } = browserHandler();
  const cases = [
    [{ verb: 'click', service: 'ebloc', bracket: ['26', '--confirm'] }, '[agent:browser click ebloc 26 --confirm]', subagent.NO_CONFIRM],
    [{ verb: 'note', service: 'ebloc', bracket: ['--forget'] }, '[agent:browser note ebloc --forget]', subagent.NO_FORGET],
  ];
  for (const [args, intent, error] of cases) {
    const viaTool = await handle({ tool: 'browser', args }, ctl);
    assert.deepStrictEqual(viaTool, { ok: false, status: 'refused', error });
    assert.deepStrictEqual(await handle({ intent }, ctl), viaTool);
  }
  assert.deepStrictEqual(seen, []);
}));

test('release: the mapper refuses first (invalid) where the intent form is refused by policy (refused) — same text', () => withBrowserVerb(async () => {
  const { handle, seen } = browserHandler();
  assert.deepStrictEqual(await handle({ tool: 'browser', args: { verb: 'release', service: 'ebloc' } }, ctl), { ok: false, status: 'invalid', error: subagent.NO_RELEASE });
  assert.deepStrictEqual(await handle({ intent: '[agent:browser release ebloc]' }, ctl), { ok: false, status: 'refused', error: subagent.NO_RELEASE });
  assert.deepStrictEqual(seen, []);
}));

test('identity fields on a tool request are ignored: a main stamp does not lift subagent policy', () => withBrowserVerb(async () => {
  const args = { verb: 'click', service: 'ebloc', bracket: ['26', '--confirm'] };
  for (const extra of [{ ident: MAIN }, { agentId: 'main-thread' }, { agentType: 'main' }]) {
    const { handle, seen } = browserHandler();
    assert.deepStrictEqual(await handle({ tool: 'browser', args, ...extra }, ctl), { ok: false, status: 'refused', error: subagent.NO_CONFIRM }, JSON.stringify(Object.keys(extra)));
    assert.deepStrictEqual(seen, []);
  }
  const { handle, seen } = browserHandler();
  assert.deepStrictEqual(await handle({ intent: '[agent:browser click ebloc 26 --confirm]', ident: MAIN }, ctl), { ok: true, status: 'ok', reply: 'ok' });
  assert.deepStrictEqual(seen, ['click ebloc 26 --confirm']);
}));

test('shape: intent and tool together, non-object args and non-string names are rejected before the registry', () => withBrowserVerb(async () => {
  const { handle, seen } = browserHandler();
  assert.deepStrictEqual(await handle({ intent: '[agent:browser read ebloc]', tool: 'browser', args: {} }, ctl), { ok: false, error: 'one of intent or tool' });
  for (const args of [undefined, null, [], 'x', 3]) {
    assert.deepStrictEqual(await handle({ tool: 'browser', args }, ctl), { ok: false, status: 'invalid', error: 'arguments must be an object' }, String(args));
  }
  assert.deepStrictEqual(await handle({ tool: 7, args: {} }, ctl), { ok: false, status: 'refused', error: 'unknown tool: "7"' });
  assert.deepStrictEqual(await handle({ tool: '../x', args: {} }, ctl), { ok: false, status: 'refused', error: 'unknown tool: "../x"' });
  assert.deepStrictEqual(seen, []);
}));

test('the grant is checked before the mapper runs; an ungranted tool reads exactly like an unregistered one', async () => {
  let calls = 0;
  const spy = { ...TOOL, toIntent: (args) => { calls += 1; return TOOL.toIntent(args); } };
  await withBrowserVerb(async () => {
    const args = { verb: 'read', service: 'ebloc' };
    for (const entry of [{ intents: [], plugins: ['browser-pane'] }, { intents: ['browser'], plugins: [] }]) {
      const { handle, seen } = browserHandler(entry);
      assert.deepStrictEqual(await handle({ tool: 'browser', args }, ctl), { ok: false, status: 'refused', error: 'unknown tool: "browser"' }, JSON.stringify(entry));
      assert.deepStrictEqual(seen, []);
    }
    assert.strictEqual(calls, 0);
    const { handle, seen } = browserHandler();
    assert.deepStrictEqual(await handle({ tool: 'nope', args }, ctl), { ok: false, status: 'refused', error: 'unknown tool: "nope"' });
    assert.deepStrictEqual(await handle({ tool: 'browser', args }, ctl), { ok: true, status: 'ok', reply: 'ok' });
    assert.strictEqual(calls, 1);
    assert.deepStrictEqual(seen, ['read ebloc']);
  }, spy);
});

test('a mapper throw answers invalid with its message on one line', async () => {
  await withBrowserVerb(async () => {
    const { handle, seen } = browserHandler();
    assert.deepStrictEqual(await handle({ tool: 'browser', args: { verb: 'jump' } }, ctl), { ok: false, status: 'invalid', error: 'verb must be one of ' + subagent.SUBS.join(', ') });
    assert.deepStrictEqual(await handle({ tool: 'browser', args: { verb: 'read', service: 'ebloc', body: 'a\nb' } }, ctl), { ok: false, status: 'invalid', error: 'body must be one line' });
    assert.deepStrictEqual(seen, []);
  });
  try {
    registry.registerIntent({ verb: 'yyy', parse: () => null, tools: [fakeTool('nl', { toIntent: () => { throw new Error('x\ny'); } })], subagent: fakePolicy }, 'yyy-plugin');
    const { handle } = browserHandler({ intents: ['yyy'], plugins: ['yyy-plugin'] });
    assert.deepStrictEqual(await handle({ tool: 'nl', args: {} }, ctl), { ok: false, status: 'invalid', error: 'x y' });
  } finally { registry._resetPluginRows(); }
});

test('a mapper emitting anything but one intent of its own verb is a foreign intent: never dispatched, one warn line', async () => {
  const outs = { evil: '[agent:dm x] hi', prefix: '[agent:zzzz y]', twice: '[agent:zzz a]\n[agent:end]\n[agent:dm x] y\n[agent:end]', nonstring: 42 };
  try {
    registry.registerIntent({ verb: 'zzz', parse: () => null, tools: Object.entries(outs).map(([n, out]) => fakeTool(n, { toIntent: () => out })), subagent: fakePolicy }, 'zzz-plugin');
    for (const name of Object.keys(outs)) {
      const { handle, seen } = browserHandler({ intents: ['zzz'], plugins: ['zzz-plugin'] });
      const before = warns.length;
      assert.deepStrictEqual(await handle({ tool: name, args: { k: 'v' } }, ctl), { ok: false, error: `tool ${name} emitted a foreign intent` });
      assert.deepStrictEqual(seen, []);
      const lines = warns.slice(before);
      assert.strictEqual(lines.length, 1, name);
      assert.ok(lines[0].includes(`tool ${name} `), lines[0]);
      assert.ok(!lines[0].includes('hi') && !lines[0].includes(' y'), lines[0]);
    }
  } finally { registry._resetPluginRows(); }
});

test('without the tools dep a tool request is not available and intent requests are unaffected', () => withBrowserVerb(async () => {
  const { handle, seen } = browserHandler(SEAT, { tools: null });
  assert.deepStrictEqual(await handle({ tool: 'browser', args: { verb: 'read', service: 'ebloc' } }, ctl), { ok: false, error: 'tool calls are not available' });
  assert.deepStrictEqual(await handle({ intent: '[agent:browser read ebloc]' }, ctl), { ok: true, status: 'ok', reply: 'ok' });
  assert.deepStrictEqual(seen, ['read ebloc']);
}));

test('no warn line from this file carries a credential or an argument', () => {
  assert.ok(warns.length > 0);
  for (const w of warns) {
    assert.ok(!w.includes(HCRED), w);
    assert.ok(!w.includes('ebloc'), w);
  }
});
