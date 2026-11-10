'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { scanIntentLines } = require('../intent-segments');
const registry = require('../intent-registry');
const { createIntentRequestHandler } = require('../intent-socket');
const { contextStatusOf } = require('../ctx-reminder');
const { ctxWindowSource } = require('../argv-merge');

const AT = Date.parse('2026-11-10T10:00:00.000Z');
const REC = { tok: 412345, size: 1000000, model: 'claude-opus-5-5', source: 'table', at: AT };

test('contextStatusOf: a fed record comes back field for field', () => {
  assert.deepStrictEqual(contextStatusOf(REC, AT + 125_400), {
    known: true, used_tokens: 412345, window: 1000000, window_source: 'table', used_percentage: 41.2,
    model: 'claude-opus-5-5', measured_at: '2026-11-10T10:00:00.000Z', age_s: 125,
  });
  assert.deepStrictEqual(contextStatusOf({ tok: 50000, size: 400000, model: 'claude-sonnet-5', source: 'cli', at: AT }, AT), {
    known: true, used_tokens: 50000, window: 400000, window_source: 'cli', used_percentage: 12.5,
    model: 'claude-sonnet-5', measured_at: '2026-11-10T10:00:00.000Z', age_s: 0,
  });
});

test('contextStatusOf: a record with no window falls back to 200000 as default', () => {
  assert.deepStrictEqual(contextStatusOf({ tok: 20000, size: 0, model: null, source: 'default', at: AT }, AT + 1000), {
    known: true, used_tokens: 20000, window: 200000, window_source: 'default', used_percentage: 10,
    model: null, measured_at: '2026-11-10T10:00:00.000Z', age_s: 1,
  });
});

test('contextStatusOf: no record is known:false with a reason and no zeros', () => {
  const expected = { known: false, reason: 'no context measurement since this session started or last reset', stale: true };
  assert.deepStrictEqual(contextStatusOf(null, AT), expected);
  assert.deepStrictEqual(contextStatusOf(undefined, AT), expected);
});

test('contextStatusOf: stale only past 10 minutes', () => {
  assert.strictEqual(contextStatusOf(REC, AT + 600_000).stale, undefined);
  const old = contextStatusOf(REC, AT + 600_001);
  assert.strictEqual(old.stale, true);
  assert.strictEqual(old.age_s, 600);
  assert.strictEqual(old.used_tokens, 412345);
});

test('ctxWindowSource: cli, table and default each from a literal statusline line', () => {
  assert.strictEqual(ctxWindowSource('12\t48000\t400000\tclaude-sonnet-5\t0.1\tSonnet 5'), 'cli');
  assert.strictEqual(ctxWindowSource('20\t100000\t200000\tclaude-fable-5'), 'table');
  assert.strictEqual(ctxWindowSource('20\t100000\t200000\tclaude-opus-5-5[1m]'), 'table');
  assert.strictEqual(ctxWindowSource('20\t100000\t1000000\tclaude-opus-5-5'), 'cli');
  assert.strictEqual(ctxWindowSource('42'), 'default');
  assert.strictEqual(ctxWindowSource('5\t9000\t0\tsome-model'), 'default');
});

const names = (entry) => registry.subagentCatalogFor(entry).tools.map((t) => t.name);

test('catalog: context_status is listed for a seat with the context intent and absent without it', () => {
  const withIt = names({ intents: ['context', 'dm'] });
  assert.ok(withIt.includes('dm'), 'ENTER: the seat lists its other tools');
  assert.ok(withIt.includes('context_status'));
  assert.deepStrictEqual(registry.subagentCatalogFor({ intents: ['context'] }).tools, [{
    name: 'context_status', description: registry.CONTEXT_STATUS_TOOL.description,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }, logKeys: [],
  }]);
  const without = names({ intents: ['dm', 'term'] });
  assert.ok(without.includes('term_read'), 'ENTER: the seat lists its other tools');
  assert.ok(!without.includes('context_status'));
});

function parse(text) {
  return scanIntentLines(text.split('\n'), {}).filter((s) => s.kind === 'intent').map((s) => s.intent);
}

function handler(entry) {
  const seen = [];
  const handle = createIntentRequestHandler({
    seat: 'h1', parse, entryOf: () => entry, sessionIdOf: () => 'main-thread', cred: 'c'.repeat(64),
    refusal: registry.subagentRefusal,
    tools: { rowFor: registry.toolRowFor, intentFor: registry.toolIntentFor, enabled: registry.intentEnabledForSeat },
    dispatch: async (intent, opts) => { seen.push({ type: intent.type, sub: intent.sub, fromLabel: opts.fromLabel }); opts.replyTo('{"known":false}'); },
  });
  return { handle, seen };
}

const ctl = { closed: () => false };

test('socket: an unstamped call reaches the context handler and gets its reply in the same call', async () => {
  const { handle, seen } = handler({ intents: ['context'] });
  assert.deepStrictEqual(await handle({ tool: 'context_status', args: {} }, ctl), { ok: true, status: 'ok', reply: '{"known":false}' });
  assert.deepStrictEqual(seen, [{ type: 'context', sub: 'status', fromLabel: null }]);
});

test('socket: a seat without context cannot call it, and an argument is refused', async () => {
  const off = handler({ intents: ['dm'] });
  assert.deepStrictEqual(await off.handle({ tool: 'context_status', args: {} }, ctl), { ok: false, status: 'refused', error: 'unknown tool: "context_status"' });
  assert.deepStrictEqual(off.seen, []);
  const on = handler({ intents: ['context'] });
  assert.deepStrictEqual(await on.handle({ tool: 'context_status', args: { x: 1 } }, ctl),
    { ok: false, status: 'invalid', error: 'unknown argument: x (context_status takes none)' });
  assert.deepStrictEqual(on.seen, []);
});
