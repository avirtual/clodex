'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { UsageCollector } = require('../wire/sse');

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
