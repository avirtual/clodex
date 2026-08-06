'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { UsageCollector, OpenAIUsageCollector, openaiDelta } = require('../wire/sse');

test('multi-iteration server-tool turn: final message_delta usage wins (cumulative)', () => {
  // Billing contract (wirescope, billing.py:241): receipts price
  // usage_final — the LAST message_delta's cumulative numbers — with
  // message_start as fallback only. On a server-tool turn (web_search)
  // each iteration re-reads the growing context, so the final delta's
  // input_tokens (cumulative, what the server actually billed) exceeds
  // the message_start snapshot (first iteration). Do NOT "fix" this back
  // to the start value, and do NOT sum iterations[] (double-counts cache
  // fields) — take the final delta's top-level numbers as-is.
  const u = new UsageCollector();
  u.onEvent('message_start', JSON.stringify({
    type: 'message_start',
    message: {
      id: 'msg_srvtool',
      usage: { input_tokens: 2928, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 16 },
    },
  }));
  u.onEvent('message_delta', JSON.stringify({
    type: 'message_delta',
    delta: { stop_reason: 'end_turn' },
    usage: {
      input_tokens: 12969, output_tokens: 1317,
      server_tool_use: { web_search_requests: 1, web_fetch_requests: 0 },
      iterations: [
        { input_tokens: 2928, output_tokens: 51, type: 'message' },
        { input_tokens: 10041, output_tokens: 1266, type: 'message' },
      ],
    },
  }));
  const r = u.record;
  assert.equal(r.input_tokens, 12969); // cumulative, not the 2928 snapshot
  assert.equal(r.output_tokens, 1317);
  assert.equal(r.message_id, 'msg_srvtool');
});

test('single-iteration turn: message_start fields survive when delta omits them', () => {
  const u = new UsageCollector();
  u.onEvent('message_start', JSON.stringify({
    type: 'message_start',
    message: { id: 'm1', usage: { input_tokens: 10, cache_read_input_tokens: 5 } },
  }));
  u.onEvent('message_delta', JSON.stringify({
    type: 'message_delta',
    usage: { output_tokens: 42 },
  }));
  const r = u.record;
  assert.equal(r.input_tokens, 10); // start value is the fallback
  assert.equal(r.cache_read_input_tokens, 5);
  assert.equal(r.output_tokens, 42);
});

test('no usage events → null record', () => {
  const u = new UsageCollector();
  u.onEvent('content_block_delta', '{"type":"content_block_delta"}');
  assert.equal(u.record, null);
});

test('meta: usage_final is the LAST delta verbatim (replaced, not merged); merged record still merges', () => {
  const u = new UsageCollector();
  u.onEvent('message_start', JSON.stringify({
    type: 'message_start',
    message: { id: 'm2', model: 'claude-haiku-4-5-20251001',
      usage: { input_tokens: 10, service_tier: 'standard' } },
  }));
  u.onEvent('message_delta', JSON.stringify({
    type: 'message_delta', delta: {},
    usage: { output_tokens: 5, cache_read_input_tokens: 99 },
  }));
  u.onEvent('message_delta', JSON.stringify({
    type: 'message_delta', delta: { stop_reason: 'end_turn' },
    usage: { output_tokens: 9 },
  }));
  const m = u.meta;
  // final delta's object AS-IS — no cache_read_input_tokens carried over
  assert.deepEqual(m.usage_final, { output_tokens: 9 });
  assert.deepEqual(m.usage_start, { input_tokens: 10, service_tier: 'standard' });
  assert.equal(m.resolved_model, 'claude-haiku-4-5-20251001');
  assert.equal(m.stop_reason, 'end_turn');
  // the merged telemetry view keeps everything seen
  assert.equal(u.record.cache_read_input_tokens, 99);
  assert.equal(u.record.output_tokens, 9);
});

test('meta: content_block_start collects block types and tool names; error captured', () => {
  const u = new UsageCollector();
  u.onEvent('content_block_start', JSON.stringify({
    type: 'content_block_start', content_block: { type: 'text' },
  }));
  u.onEvent('content_block_start', JSON.stringify({
    type: 'content_block_start', content_block: { type: 'tool_use', name: 'Bash' },
  }));
  u.onEvent('error', JSON.stringify({
    type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' },
  }));
  const m = u.meta;
  assert.deepEqual(m.content_block_types, ['text', 'tool_use']);
  assert.deepEqual(m.tool_uses, ['Bash']);
  assert.equal(m.error.type, 'overloaded_error');
});

test('OpenAIUsageCollector: response.completed carries usage + model + status', () => {
  const u = new OpenAIUsageCollector();
  u.onEvent(null, JSON.stringify({ type: 'response.output_text.delta', delta: 'hi' }));
  u.onEvent(null, JSON.stringify({
    type: 'response.completed',
    response: { id: 'resp_1', model: 'gpt-5.3-codex', status: 'completed',
      usage: { input_tokens: 50, output_tokens: 7,
        input_tokens_details: { cached_tokens: 30 } } },
  }));
  const m = u.meta;
  assert.equal(m.resolved_model, 'gpt-5.3-codex');
  assert.equal(m.status, 'completed');
  assert.equal(m.usage.input_tokens, 50);
  assert.equal(m.response_id, 'resp_1');
  assert.equal(m.error, null);
});

test('OpenAIUsageCollector: response.failed surfaces the error', () => {
  const u = new OpenAIUsageCollector();
  u.onEvent(null, JSON.stringify({
    type: 'response.failed',
    response: { id: 'resp_2', status: 'failed', error: { code: 'server_error' } },
  }));
  assert.equal(u.meta.status, 'failed');
  assert.equal(u.meta.error.code, 'server_error');
});

// --- openaiDelta -------------------------------------------------------------

// The openai half of the discriminated-return change, which has no e2e fixture:
// this function's output becomes turn.text, and turn.text is what the intent
// scanner reads. A reversion to a bare string leaves `d.s` undefined, blanking
// every Codex turn's text — intents stop firing and nothing else goes red.
test('openaiDelta returns the discriminated shape both APIs share', () => {
  assert.deepStrictEqual(
    openaiDelta('', JSON.stringify({ type: 'response.output_text.delta', delta: 'hi' })),
    { kind: 'text', s: 'hi' },
  );
  assert.deepStrictEqual(
    openaiDelta('', JSON.stringify({ choices: [{ delta: { content: 'hi' } }] })),
    { kind: 'text', s: 'hi' },
  );
  // Never 'thinking': reasoning summaries are opt-in, arrive on their own event
  // and are deliberately not captured here.
  assert.strictEqual(openaiDelta('', '[DONE]'), null);
  assert.strictEqual(openaiDelta('', 'not json'), null);
  assert.strictEqual(openaiDelta('', ''), null);
  assert.strictEqual(openaiDelta('', JSON.stringify({ choices: [] })), null);
});
