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
const { seenIdent, consume: wireSaw, wire: seenWire } = require('./lib/wire-seen').wireSeenStamps();

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
const MAIN = () => seenIdent(crypto, HCRED, null, null, 'main-thread');
const TOOLS = { rowFor: registry.toolRowFor, intentFor: registry.toolIntentFor, enabled: registry.intentEnabledForSeat };
const warns = [];
const log = { warn: (tag, msg) => warns.push(`${tag} ${msg}`) };

function browserHandler(entry = SEAT, { tools = TOOLS } = {}) {
  const seen = [];
  const handle = createIntentRequestHandler({
    consumeMainToolUse: wireSaw,
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

test('release and close: the tool form and the intent form are both refused by policy with the same text', () => withBrowserVerb(async () => {
  const { handle, seen } = browserHandler();
  for (const [verb, error] of [['release', subagent.NO_RELEASE], ['close', subagent.NO_CLOSE]]) {
    assert.deepStrictEqual(await handle({ tool: 'browser', args: { verb, service: 'ebloc' } }, ctl), { ok: false, status: 'refused', error });
    assert.deepStrictEqual(await handle({ intent: `[agent:browser ${verb} ebloc]` }, ctl), { ok: false, status: 'refused', error });
  }
  assert.deepStrictEqual(seen, []);
}));

test('identity fields on a tool request are ignored: a main stamp does not lift subagent policy', () => withBrowserVerb(async () => {
  const args = { verb: 'click', service: 'ebloc', bracket: ['26', '--confirm'] };
  for (const extra of [{ ident: MAIN() }, { agentId: 'main-thread' }, { agentType: 'main' }]) {
    const { handle, seen } = browserHandler();
    assert.deepStrictEqual(await handle({ tool: 'browser', args, ...extra }, ctl), { ok: false, status: 'refused', error: subagent.NO_CONFIRM }, JSON.stringify(Object.keys(extra)));
    assert.deepStrictEqual(seen, []);
  }
  const { handle, seen } = browserHandler();
  assert.deepStrictEqual(await handle({ intent: '[agent:browser click ebloc 26 --confirm]', ident: MAIN() }, ctl), { ok: true, status: 'ok', reply: 'ok' });
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

test('a mapper line that parses as ONE intent of another verb is a foreign intent', async () => {
  try {
    registry.registerIntent({ verb: 'zzz', parse: () => null, tools: [fakeTool('other', { toIntent: () => '[agent:zzz a]\n[agent:end]\n' })], subagent: fakePolicy }, 'zzz-plugin');
    const seen = [];
    const handle = createIntentRequestHandler({
      consumeMainToolUse: wireSaw,
      seat: 'h1', parse: () => [{ type: 'yyy', raw: 'a' }], entryOf: () => ({ intents: ['zzz'], plugins: ['zzz-plugin'] }), sessionIdOf: () => 'main-thread', cred: HCRED, log,
      refusal: registry.subagentRefusal, tools: TOOLS,
      dispatch: async (intent, opts) => { seen.push(intent.raw); opts.replyTo('ok'); },
    });
    const before = warns.length;
    assert.deepStrictEqual(await handle({ tool: 'other', args: {} }, ctl), { ok: false, error: 'tool other emitted a foreign intent' });
    assert.deepStrictEqual(seen, []);
    assert.strictEqual(warns.length - before, 1);
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

const TERM_SEAT = { intents: ['term'] };

function termHandler(entry = TERM_SEAT, { reply = '[terminal] ls\nexit 0', sessionIdOf = () => 'main-thread', identSeen = new Map(), consumeMainToolUse = wireSaw } = {}) {
  const seen = [];
  const handle = createIntentRequestHandler({
    consumeMainToolUse,
    seat: 'h1', parse, entryOf: () => entry, sessionIdOf, cred: HCRED, log, identSeen,
    refusal: registry.subagentRefusal, tools: TOOLS,
    classifyReply: (i, l) => registry.classifyReplyLine(i.type, l),
    dispatch: async (intent, opts) => { seen.push({ type: intent.type, sub: intent.sub, body: intent.body, fromLabel: opts.fromLabel, hasIdent: 'ident' in intent }); opts.replyTo(reply); },
  });
  return { handle, seen, identSeen };
}

const UNKNOWN_TERM = { ok: false, status: 'refused', error: 'unknown tool: "term_exec"' };
const freshMain = (sid = 'main-thread') => seenIdent(crypto, HCRED, null, null, sid);

test('term_exec: a verified main stamp dispatches as main and the reply comes back verbatim', async () => {
  const { handle, seen } = termHandler(TERM_SEAT, { reply: 'ok' });
  const ident = freshMain();
  const r = await handle({ tool: 'term_exec', args: { command: 'ls' }, ident }, ctl);
  assert.deepStrictEqual(r, { ok: true, status: 'ok', reply: 'ok' });
  assert.deepStrictEqual(seen, [{ type: 'term', sub: 'exec', body: 'ls', fromLabel: null, hasIdent: false }]);
});

test('term_exec: no stamp, a replay, a sub stamp, another session and a bare agentId all answer unknown tool', async () => {
  const replayed = freshMain();
  const first = termHandler();
  assert.strictEqual((await first.handle({ tool: 'term_exec', args: { command: 'ls' }, ident: replayed }, ctl)).ok, true);
  warns.length = 0;
  const cases = [
    ['none', {}],
    ['sub', { ident: seenIdent(crypto, HCRED, 'a1', 'gp', 'main-thread') }],
    ['other session', { ident: freshMain('other-thread') }],
    ['agentId', { agentId: 'main-thread' }],
  ];
  for (const [label, extra] of cases) {
    const { handle, seen } = termHandler();
    assert.deepStrictEqual(await handle({ tool: 'term_exec', args: { command: 'ls' }, ...extra }, ctl), UNKNOWN_TERM, label);
    assert.deepStrictEqual(seen, [], label);
  }
  assert.deepStrictEqual(warns, []);
  const before = first.seen.length;
  assert.deepStrictEqual(await first.handle({ tool: 'term_exec', args: { command: 'ls' }, ident: replayed }, ctl), UNKNOWN_TERM);
  assert.strictEqual(first.seen.length, before);
  assert.deepStrictEqual(warns, ['intent-socket h1: replayed identity stamp refused']);
  warns.length = 0;
});

test('term_exec: no session id refuses even a valid-looking stamp', async () => {
  const { handle, seen } = termHandler(TERM_SEAT, { sessionIdOf: () => null });
  assert.deepStrictEqual(await handle({ tool: 'term_exec', args: { command: 'ls' }, ident: freshMain() }, ctl), UNKNOWN_TERM);
  assert.deepStrictEqual(seen, []);
});

test('term_exec: only a seat whose intents list term may call it, and an ungranted call consumes no nonce', async () => {
  for (const entry of [{ intents: ['*'] }, { intents: [] }, {}]) {
    const { handle, seen, identSeen } = termHandler(entry);
    assert.deepStrictEqual(await handle({ tool: 'term_exec', args: { command: 'ls' }, ident: freshMain() }, ctl), UNKNOWN_TERM, JSON.stringify(entry));
    assert.deepStrictEqual(seen, []);
    assert.strictEqual(identSeen.size, 0);
  }
  const { handle, identSeen } = termHandler({ intents: ['*', 'term'] }, { reply: 'ok' });
  assert.deepStrictEqual(await handle({ tool: 'term_exec', args: { command: 'ls' }, ident: freshMain() }, ctl), { ok: true, status: 'ok', reply: 'ok' });
  assert.strictEqual(identSeen.size, 1);
});

test('term_exec: the mapper rejects a second line, an empty command and any key but command', async () => {
  const cases = [
    [{ command: 'a\nb' }, 'command must be one line'],
    [{}, 'command must be a non-empty string'],
    [{ command: '  ' }, 'command must be a non-empty string'],
    [{ command: 'ls', x: 1 }, 'unknown argument: x (use command)'],
    [{ command: 'ls', ident: 'x' }, 'unknown argument: ident (use command)'],
  ];
  for (const [args, error] of cases) {
    const { handle, seen } = termHandler();
    assert.deepStrictEqual(await handle({ tool: 'term_exec', args, ident: freshMain() }, ctl), { ok: false, status: 'invalid', error }, JSON.stringify(args));
    assert.deepStrictEqual(seen, []);
  }
});

test('a main stamp lifts the core term_exec row to main but never a plugin row', () => withBrowserVerb(async () => {
  const browser = browserHandler({ intents: ['browser', 'term'], plugins: ['browser-pane'] });
  assert.deepStrictEqual(await browser.handle({ tool: 'browser', args: { verb: 'click', service: 'ebloc', bracket: ['26', '--confirm'] }, ident: freshMain() }, ctl), { ok: false, status: 'refused', error: subagent.NO_CONFIRM });
  assert.deepStrictEqual(browser.seen, []);
  const term = termHandler({ intents: ['browser', 'term'], plugins: ['browser-pane'] }, { reply: 'ok' });
  assert.deepStrictEqual(await term.handle({ tool: 'term_exec', args: { command: 'ls' }, ident: freshMain() }, ctl), { ok: true, status: 'ok', reply: 'ok' });
  assert.deepStrictEqual(term.seen, [{ type: 'term', sub: 'exec', body: 'ls', fromLabel: null, hasIdent: false }]);
}));

test('term_exec: the terminal text is ok, an [agent:term] line is refused, and the dispatched intent carries no ident', async () => {
  const cases = [
    ['[terminal] ls\nexit 1\noutput (last 1 of 1 lines):\nx', 'ok'],
    ['[agent:term] busy: a command is already running', 'refused'],
  ];
  for (const [reply, status] of cases) {
    const { handle, seen } = termHandler(TERM_SEAT, { reply });
    const ident = freshMain();
    const r = await handle({ tool: 'term_exec', args: { command: 'ls' }, ident }, ctl);
    assert.deepStrictEqual(r, { ok: true, status, reply });
    assert.deepStrictEqual(seen.map((s) => s.hasIdent), [false]);
  }
});

const SUB_STAMP = (sid = 'main-thread') => seenIdent(crypto, HCRED, 'ageneral-purpose-0123456789abcdef', 'general-purpose', sid);

test('a verified sub stamp: a core term_exec call still answers unknown tool', async () => {
  const { handle, seen, identSeen } = termHandler();
  assert.deepStrictEqual(await handle({ tool: 'term_exec', args: { command: 'ls' }, ident: SUB_STAMP() }, ctl), UNKNOWN_TERM);
  assert.deepStrictEqual(seen, []);
  assert.strictEqual(identSeen.size, 1);
});

test('a verified sub stamp on a plugin tool call: fromLabel stays the shared tag and no identity rides along', () => withBrowserVerb(async () => {
  const opts = [];
  const handle = createIntentRequestHandler({
    consumeMainToolUse: wireSaw,
    seat: 'h1', parse, entryOf: () => SEAT, sessionIdOf: () => 'main-thread', cred: HCRED, log,
    refusal: registry.subagentRefusal, tools: TOOLS, nameFor: () => 'alice',
    dispatch: async (intent, o) => { opts.push({ fromLabel: o.fromLabel, fromIdent: o.fromIdent }); o.replyTo('ok'); },
  });
  assert.deepStrictEqual(await handle({ tool: 'browser', args: { verb: 'read', service: 'ebloc' }, ident: SUB_STAMP() }, ctl), { ok: true, status: 'ok', reply: 'ok' });
  assert.deepStrictEqual(opts, [{ fromLabel: 'h1/agent', fromIdent: null }]);
}));

const DM_SEAT = { intents: ['dm'] };
const UNKNOWN_DM = { ok: false, status: 'refused', error: 'unknown tool: "dm"' };

function dmHandler({ sessionIdOf = () => 'main-thread', reply = null } = {}) {
  const seen = [];
  const handle = createIntentRequestHandler({
    consumeMainToolUse: wireSaw,
    seat: 'h1', parse, entryOf: () => DM_SEAT, sessionIdOf, cred: HCRED, log, identSeen: new Map(),
    refusal: registry.subagentRefusal, tools: TOOLS, nameFor: () => 'alice',
    classifyReply: (i, l) => registry.classifyReplyLine(i.type, l),
    dispatch: async (intent, opts) => { seen.push({ intent, opts }); if (reply) opts.replyTo(reply); },
  });
  return { handle, seen };
}

const DM_SUB_SENT = { ok: true, status: 'ok', reply: 'sent to b; a reply arrives as a note after your next tool call' };

test('dm tool: a verified sub stamp dispatches the dm as the named subagent', async () => {
  const { handle, seen } = dmHandler();
  assert.deepStrictEqual(await handle({ tool: 'dm', args: { to: 'b', body: 'hi' }, ident: SUB_STAMP() }, ctl), DM_SUB_SENT);
  assert.strictEqual(seen.length, 1);
  assert.strictEqual(seen[0].intent.target, 'b');
  assert.strictEqual(seen[0].intent.body, 'hi');
  const { replyTo } = seen[0].opts;
  assert.deepStrictEqual(seen[0].opts, { replyTo, fromLabel: 'h1/agent', fromIdent: { agentId: 'ageneral-purpose-0123456789abcdef', agentType: 'general-purpose', label: 'h1/alice' } });
});

test('dm tool: a forged, replayed, missing or foreign-session stamp answers unknown tool and dispatches nothing', async () => {
  const forged = SUB_STAMP().replace(/\.[0-9a-f]+$/, '.deadbeefdeadbeef');
  for (const ident of [forged, undefined, SUB_STAMP('other-session')]) {
    const { handle, seen } = dmHandler();
    assert.deepStrictEqual(await handle({ tool: 'dm', args: { to: 'b', body: 'hi' }, ident }, ctl), UNKNOWN_DM, String(ident));
    assert.deepStrictEqual(seen, []);
  }
  const { handle, seen } = dmHandler();
  const stamp = SUB_STAMP();
  assert.deepStrictEqual(await handle({ tool: 'dm', args: { to: 'b', body: 'hi' }, ident: stamp }, ctl), DM_SUB_SENT);
  assert.deepStrictEqual(await handle({ tool: 'dm', args: { to: 'b', body: 'hi' }, ident: stamp }, ctl), UNKNOWN_DM);
  assert.strictEqual(seen.length, 1);
  assert.deepStrictEqual(warns, ['intent-socket h1: replayed identity stamp refused']);
  warns.length = 0;
});

test('dm tool: a main stamp delivers the dm and the reply carries the do-not-use-again correction', async () => {
  const { handle, seen } = dmHandler();
  assert.deepStrictEqual(await handle({ tool: 'dm', args: { to: 'b', body: 'hi' }, ident: freshMain() }, ctl), { ok: true, status: 'ok', reply: "sent to b; a reply arrives in the seat's main conversation. Do not use this tool again: as the main agent, write [agent:dm <seat>] body … [agent:end] in your reply — it dispatches in the same request." });
  assert.strictEqual(seen.length, 1);
  const { replyTo } = seen[0].opts;
  assert.deepStrictEqual(seen[0].opts, { replyTo, fromLabel: null, fromIdent: null });
});

test('dm tool: a main stamp whose dm is parked gets the handler line unchanged', async () => {
  for (const reply of ["[agent:dm] parked for b (busy) as p1 — it'll be delivered with b's next turn.", '[agent:dm] delivered to b/alice (a note for its queue)']) {
    const { handle, seen } = dmHandler({ reply });
    assert.deepStrictEqual(await handle({ tool: 'dm', args: { to: 'b', body: 'hi' }, ident: freshMain() }, ctl), { ok: true, status: 'ok', reply });
    assert.strictEqual(seen.length, 1);
  }
});

test('dm tool: a main stamp whose dm is not delivered gets the handler line and no correction', async () => {
  const reply = '[agent:dm] NOT delivered: b is not running';
  const { handle, seen } = dmHandler({ reply });
  assert.deepStrictEqual(await handle({ tool: 'dm', args: { to: 'b', body: 'hi' }, ident: freshMain() }, ctl), { ok: true, status: 'error', reply });
  assert.strictEqual(seen.length, 1);
});

test('dm tool: a decorated intent line in the body is a foreign intent and nothing is dispatched', async () => {
  const { handle, seen } = dmHandler();
  const before = warns.length;
  assert.deepStrictEqual(await handle({ tool: 'dm', args: { to: 'b', body: 'x\n\u2022 [agent:who]' }, ident: SUB_STAMP() }, ctl), { ok: false, error: 'tool dm emitted a foreign intent' });
  assert.deepStrictEqual(seen, []);
  warns.length = before;
});

test('subagentOk on a plugin tool lifts nothing: the plugin branch dispatches with no identity', async () => {
  try {
    registry.registerIntent({ verb: 'zzz', parse: () => null, tools: [fakeTool('x', { subagentOk: true, toIntent: () => '[agent:zzz a]' })], subagent: fakePolicy }, 'zzz-plugin');
    const opts = [];
    const handle = createIntentRequestHandler({
      consumeMainToolUse: wireSaw,
      seat: 'h1', parse: () => [{ type: 'zzz', raw: 'a' }], entryOf: () => ({ intents: ['zzz'], plugins: ['zzz-plugin'] }), sessionIdOf: () => 'main-thread', cred: HCRED, log,
      refusal: () => null, tools: TOOLS, nameFor: () => 'alice',
      dispatch: async (intent, o) => { opts.push({ fromLabel: o.fromLabel, fromIdent: o.fromIdent }); o.replyTo('ok'); },
    });
    assert.deepStrictEqual(await handle({ tool: 'x', args: {}, ident: SUB_STAMP() }, ctl), { ok: true, status: 'ok', reply: 'ok' });
    assert.deepStrictEqual(opts, [{ fromLabel: 'h1/agent', fromIdent: null }]);
  } finally { registry._resetPluginRows(); }
});

test('dm tool: a refusal line from the dm arm reports status refused', async () => {
  const reply = '[agent:dm] refused: a subagent dm is never urgent';
  const { handle } = dmHandler({ reply });
  assert.deepStrictEqual(await handle({ tool: 'dm', args: { to: 'b', body: 'hi' }, ident: SUB_STAMP() }, ctl), { ok: true, status: 'refused', reply });
});

const EXEC_SEAT = { intents: ['*'] };
const UNKNOWN_EXEC = { ok: false, status: 'refused', error: 'unknown tool: "exec"' };
const EXEC_ARGS = { command: 'clodex-ctl-read', payload: { ctx: 'local', verb: 'get' } };

function execHandler(entry = EXEC_SEAT, { reply = '[agent:exec] clodex-ctl-read: [ctl local exit 0] x', dispatch = null, replyWaitMs = null, setTimer, identSeen = new Map() } = {}) {
  const seen = [];
  const handle = createIntentRequestHandler({
    consumeMainToolUse: wireSaw,
    seat: 'h1', parse, entryOf: () => entry, sessionIdOf: () => 'main-thread', cred: HCRED, log, identSeen,
    refusal: registry.subagentRefusal, tools: TOOLS, replyWaitMs,
    ...(setTimer ? { setTimer, clearTimer: () => {} } : {}),
    classifyReply: (i, l) => registry.classifyReplyLine(i.type, l),
    dispatch: dispatch || (async (intent, opts) => { seen.push({ type: intent.type, cmd: intent.cmd, body: intent.body, fromLabel: opts.fromLabel, hasIdent: 'ident' in intent }); opts.replyTo(reply); }),
  });
  return { handle, seen, identSeen };
}

test('exec: a verified main stamp dispatches the exec intent as main and the reply comes back verbatim', async () => {
  const { handle, seen } = execHandler();
  assert.deepStrictEqual(await handle({ tool: 'exec', args: EXEC_ARGS, ident: freshMain() }, ctl),
    { ok: true, status: 'ok', reply: '[agent:exec] clodex-ctl-read: [ctl local exit 0] x' });
  assert.deepStrictEqual(seen, [{ type: 'exec', cmd: 'clodex-ctl-read', body: '{"ctx":"local","verb":"get"}', fromLabel: null, hasIdent: false }]);
});

test('exec: no stamp, a sub stamp, a replay, another session, a bare agentId and an ungranted seat all answer unknown tool: "exec", consuming no nonce', async () => {
  const replayed = freshMain();
  const first = execHandler();
  assert.strictEqual((await first.handle({ tool: 'exec', args: EXEC_ARGS, ident: replayed }, ctl)).ok, true);
  warns.length = 0;
  for (const [label, extra] of [
    ['none', {}],
    ['sub', { ident: seenIdent(crypto, HCRED, 'a1', 'gp', 'main-thread') }],
    ['other session', { ident: freshMain('other-thread') }],
    ['agentId', { agentId: 'main-thread' }],
  ]) {
    const { handle, seen } = execHandler();
    assert.deepStrictEqual(await handle({ tool: 'exec', args: EXEC_ARGS, ...extra }, ctl), UNKNOWN_EXEC, label);
    assert.deepStrictEqual(seen, [], label);
  }
  const before = first.seen.length;
  assert.deepStrictEqual(await first.handle({ tool: 'exec', args: EXEC_ARGS, ident: replayed }, ctl), UNKNOWN_EXEC);
  assert.strictEqual(first.seen.length, before);
  assert.deepStrictEqual(warns, ['intent-socket h1: replayed identity stamp refused']);
  warns.length = 0;
  for (const entry of [{ intents: [] }, { intents: ['dm'] }]) {
    const { handle, seen, identSeen } = execHandler(entry);
    assert.deepStrictEqual(await handle({ tool: 'exec', args: EXEC_ARGS, ident: freshMain() }, ctl), UNKNOWN_EXEC, JSON.stringify(entry));
    assert.deepStrictEqual(seen, []);
    assert.strictEqual(identSeen.size, 0);
  }
});

test('exec: H1 — two concurrent calls on one seat each get their own reply when the second lands first', async () => {
  const replyTos = new Map();
  const { handle } = execHandler(EXEC_SEAT, {
    replyWaitMs: () => 1000,
    setTimer: () => 0,
    dispatch: async (intent, opts) => { replyTos.set(intent.body, opts.replyTo); },
  });
  const a = handle({ tool: 'exec', args: { command: 'c', payload: { k: 'A' } }, ident: freshMain() }, ctl);
  const b = handle({ tool: 'exec', args: { command: 'c', payload: { k: 'B' } }, ident: freshMain() }, ctl);
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual([...replyTos.keys()], ['{"k":"A"}', '{"k":"B"}']);
  assert.strictEqual(replyTos.get('{"k":"B"}')('[agent:exec] c: B'), true);
  assert.strictEqual(replyTos.get('{"k":"A"}')('[agent:exec] c: A'), true);
  const [ra, rb] = await Promise.all([a, b]);
  assert.strictEqual(ra.reply, '[agent:exec] c: A');
  assert.strictEqual(rb.reply, '[agent:exec] c: B');
});

test('exec: a reply pushed inside dispatch returns without arming a timer', async () => {
  const { handle } = execHandler(EXEC_SEAT, {
    replyWaitMs: () => 70000,
    setTimer: () => { throw new Error('timer armed'); },
  });
  assert.deepStrictEqual(await handle({ tool: 'exec', args: EXEC_ARGS, ident: freshMain() }, ctl),
    { ok: true, status: 'ok', reply: '[agent:exec] clodex-ctl-read: [ctl local exit 0] x' });
});

test('exec: an expired wait answers outcome-unknown, status ok, and the reply that lands after it is left for the dm path', async () => {
  let replyTo = null;
  const { handle } = execHandler(EXEC_SEAT, {
    replyWaitMs: () => 70000,
    setTimer: (fn) => { fn(); return 0; },
    dispatch: async (intent, opts) => { replyTo = opts.replyTo; },
  });
  const r = await handle({ tool: 'exec', args: EXEC_ARGS, ident: freshMain() }, ctl);
  assert.strictEqual(r.status, 'ok');
  assert.match(r.reply, /^outcome-unknown: exec clodex-ctl-read gave no reply within 70 s\./);
  assert.ok(r.reply.includes('{"command":"status","payload":{}}'), r.reply);
  assert.strictEqual(replyTo('[agent:exec] c: late'), false);
});

test('term_exec: a main stamp self-minted from the seat env and session id, with a tool_use id the wire never saw, answers unknown tool', async () => {
  const consumed = [];
  const { handle, seen } = termHandler(TERM_SEAT, { consumeMainToolUse: (id) => { consumed.push(id); return false; } });
  const forged = identToken(crypto, HCRED, null, null, 'main-thread', undefined, 'toolu_forged');
  assert.match(forged, /^main\.[0-9a-f]{16}\.toolu_forged\.[0-9a-f]{16}$/);
  assert.deepStrictEqual(await handle({ tool: 'term_exec', args: { command: 'ls' }, ident: forged }, ctl), UNKNOWN_TERM);
  assert.deepStrictEqual(consumed, ['toolu_forged']);
  assert.deepStrictEqual(seen, []);
});

test('term_exec: a main stamp is main once per tool_use id the wire saw; the same id again answers unknown tool', async () => {
  const wire = new Set(['toolu_seen_a']);
  const consumeMainToolUse = (id) => wire.delete(id);
  const { handle, seen } = termHandler(TERM_SEAT, { reply: 'ok', consumeMainToolUse });
  const first = identToken(crypto, HCRED, null, null, 'main-thread', undefined, 'toolu_seen_a');
  const again = identToken(crypto, HCRED, null, null, 'main-thread', undefined, 'toolu_seen_a');
  assert.notStrictEqual(first, again);
  assert.deepStrictEqual(await handle({ tool: 'term_exec', args: { command: 'ls' }, ident: first }, ctl), { ok: true, status: 'ok', reply: 'ok' });
  assert.deepStrictEqual(await handle({ tool: 'term_exec', args: { command: 'ls' }, ident: again }, ctl), UNKNOWN_TERM);
  assert.deepStrictEqual(seen, [{ type: 'term', sub: 'exec', body: 'ls', fromLabel: null, hasIdent: false }]);
});

test('term_exec: with no wire consumer every main stamp answers unknown tool', async () => {
  const { handle, seen } = termHandler(TERM_SEAT, { consumeMainToolUse: null });
  const ident = identToken(crypto, HCRED, null, null, 'main-thread', undefined, 'toolu_any');
  assert.deepStrictEqual(await handle({ tool: 'term_exec', args: { command: 'ls' }, ident }, ctl), UNKNOWN_TERM);
  assert.deepStrictEqual(seen, []);
});

test('term_exec: a main stamp whose tool_use id is swapped after minting fails its mac and consumes nothing', async () => {
  const consumed = [];
  const { handle, seen } = termHandler(TERM_SEAT, { consumeMainToolUse: (id) => { consumed.push(id); return true; } });
  const minted = identToken(crypto, HCRED, null, null, 'main-thread', undefined, 'toolu_a');
  const swapped = minted.replace('.toolu_a.', '.toolu_b.');
  assert.deepStrictEqual(await handle({ tool: 'term_exec', args: { command: 'ls' }, ident: swapped }, ctl), UNKNOWN_TERM);
  assert.deepStrictEqual(consumed, []);
  assert.deepStrictEqual(seen, []);
});
