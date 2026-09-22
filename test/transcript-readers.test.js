const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { mkTmpRoot } = require('./lib/tmp-roots');
const { readerFor, sniffReader } = require('../transcript-readers');
const { createJsonlWatcher } = require('../jsonl-watcher');

const NONE = {
  text: '', isReply: false, rid: '', turnStart: false, turnEnd: false, interrupted: false,
  inert: false, sessionEnd: false, compactSummary: false, prompt: '',
};

function museRun(event, extra = {}) {
  return {
    schema_version: 1, id: 'rec-1', stream: { kind: 'session', id: '01a0c878-2bb3-7d72-ad4a-09ab8ca67279' },
    sequence: 54, recorded_at: 1790069714546084, record_type: 'event', durability: 'durable', causation_id: null,
    payload_type: 'runtime.session', payload_schema_version: 1,
    payload: { kind: 'run', run_id: '3fa3163c-9823-41f9-b660-5bb5f003d2dc', event, ...extra },
  };
}

const MUSE_MESSAGE = museRun({
  kind: 'assistant_message_committed', message_id: '6dd5822f-966f-49a1-b35c-a2ba6d3f9996',
  response_id: 'muse-tui-echo', text: 'echo: say hello',
});
const MUSE_TERMINAL_COMPLETED = museRun({ kind: 'terminal', terminal: 'completed', reason: 'run finished', turn_duration_ms: 1200 });
const MUSE_TERMINAL_CANCELLED = museRun({ kind: 'terminal', terminal: 'cancelled', reason: 'cancelled after tool result reconciliation', turn_duration_ms: 239837 });
const MUSE_STARTED = museRun({ kind: 'started', prompt: 'say hello' });
const MUSE_PROMPT = {
  schema_version: 1, id: '240bd79a-03fb-445f-87b9-b139ca68cc54', sequence: 14, record_type: 'event',
  payload_type: 'runtime.user_intent.accepted', payload_schema_version: 1,
  payload: {
    intent_id: '0a8e3527-06cc-4212-b428-6c0607c18bf3', surface: 'main', semantic_kind: { kind: 'chat' },
    refill_blocks: [{ kind: 'text', text: 'say hello' }, { kind: 'text', text: 'then stop' }],
    model_messages: [{ content: [{ kind: 'text', text: 'say hello' }] }],
  },
};
const MUSE_SESSION_END = {
  schema_version: 1, id: '684fd2d8-31ac-4d24-8d64-885ab775f7a5', sequence: 118, record_type: 'event',
  payload_type: 'session.end', payload_schema_version: 1,
  payload: { kind: 'session_end', record: { session_id: '01a0c9ab-0000-7000-8000-00000000ab01', exit_reason: 'clean', uptime_ms: 239927 } },
};
const MUSE_INERT_RUN_EVENTS = [
  'model_completed', 'goal_usage_attribution', 'context_block_diagnostic', 'context_block_updated',
  'reasoning_committed', 'reasoning_summary_delta', 'assistant_tool_calls_committed',
  'tool_result_batch_committed', 'task_stream_linked', 'resource_usage_sampled',
].map((kind) => museRun({ kind }));
const MUSE_TASK = { payload_type: 'runtime.session.task', payload_schema_version: 1, payload: { kind: 'accepted' } };
const MUSE_TOOL_BATCH = { payload_type: 'tool_batch.effect.started', payload: { kind: 'tool_batch_effect' } };
const MUSE_MODEL_CONFIGURED = { payload_type: 'run.model.configured', payload: { kind: 'run_model' } };
const MUSE_MARKER = {
  retained_marker: 'omitted_live_only', schema_version: 1,
  stream: { kind: 'session', id: '01a0c905-ce91-7812-8840-6d74a9de8301' },
  position: { id: '45fd06e5-0e06-4423-9bce-70d351bdcd99', sequence: 120 },
  omitted_record: { record_type: 'status', durability: 'ephemeral', payload_type: 'runtime.session', payload_kind: 'task', omission_class: 'task_tool_delta_v1' },
};
const FRAME_CHILD_0 = { schema_version: 1, id: 'b6049fcd', sequence: 1, payload_type: 'runtime.session.permission_format_declared', payload: { schema_version: 1, format: 'profile_v1' } };
const FRAME_CHILD_1 = { schema_version: 1, id: 'a178175e', sequence: 2, payload_type: 'runtime.session', payload: { kind: 'security_mode', mode: 'default' } };
const MUSE_FRAME = {
  retained_frame: 'session_permission_transaction', frame_schema_version: 1, outer_log_ordinal: 1,
  transaction_id: 'c40e56d0-ffe9-4851-8f69-4dcb7226f234',
  children: [
    { child_index: 0, record_json: JSON.stringify(FRAME_CHILD_0) },
    { child_index: 1, record_json: JSON.stringify(FRAME_CHILD_1) },
  ],
};

test('muse expand: a retained_frame yields its two parsed children, a marker yields nothing, a flat record itself', () => {
  const { expand } = readerFor('muse');
  assert.deepStrictEqual(expand(MUSE_FRAME), [FRAME_CHILD_0, FRAME_CHILD_1]);
  assert.deepStrictEqual(expand(MUSE_MARKER), []);
  assert.deepStrictEqual(expand({ omitted_live_only: true }), []);
  assert.deepStrictEqual(expand(MUSE_MESSAGE), [MUSE_MESSAGE]);
});

test('muse expand: an unparsable child is dropped, the parsable sibling kept', () => {
  const { expand } = readerFor('muse');
  const frame = { ...MUSE_FRAME, children: [{ child_index: 0, record_json: '{not json' }, { child_index: 1, record_json: JSON.stringify(FRAME_CHILD_1) }] };
  assert.deepStrictEqual(expand(frame), [FRAME_CHILD_1]);
});

test('muse classify table', () => {
  const { classify } = readerFor('muse');
  const rows = [
    ['assistant_message_committed', MUSE_MESSAGE, { ...NONE, text: 'echo: say hello', isReply: true, rid: '6dd5822f-966f-49a1-b35c-a2ba6d3f9996' }],
    ['terminal completed', MUSE_TERMINAL_COMPLETED, { ...NONE, turnEnd: true }],
    ['terminal cancelled', MUSE_TERMINAL_CANCELLED, { ...NONE, turnEnd: true, interrupted: true }],
    ['started', MUSE_STARTED, { ...NONE, turnStart: true }],
    ['user_intent.accepted', MUSE_PROMPT, { ...NONE, prompt: 'say hello\nthen stop' }],
    ['session.end', MUSE_SESSION_END, { ...NONE, sessionEnd: true }],
    ['runtime.session.task', MUSE_TASK, { ...NONE, inert: true }],
    ['tool_batch.effect.started', MUSE_TOOL_BATCH, { ...NONE, inert: true }],
    ['run.model.configured', MUSE_MODEL_CONFIGURED, { ...NONE, inert: true }],
    ['frame child security_mode', FRAME_CHILD_1, { ...NONE, inert: true }],
    ['unknown payload_type', { payload_type: 'session.whatever', payload: {} }, { ...NONE, inert: true }],
  ];
  for (const rec of MUSE_INERT_RUN_EVENTS) rows.push([`run ${rec.payload.event.kind}`, rec, { ...NONE, inert: true }]);
  for (const [label, rec, want] of rows) assert.deepStrictEqual(classify(rec), want, label);
});

test('claude classify table', () => {
  const { classify } = readerFor('claude');
  const rows = [
    ['assistant end_turn text', { type: 'assistant', requestId: 'r1', message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'all done' }] } },
      { ...NONE, text: 'all done', isReply: true, rid: 'r1', turnEnd: true }],
    ['assistant tool_use text', { type: 'assistant', requestId: 'r2', message: { stop_reason: 'tool_use', content: [{ type: 'text', text: 'working' }, { type: 'tool_use', name: 'Bash', input: {} }] } },
      { ...NONE, text: 'working', isReply: true, rid: 'r2' }],
    ['assistant tool_use textless', { type: 'assistant', requestId: 'r3', message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'Bash', input: {} }] } },
      { ...NONE, isReply: true, rid: 'r3', inert: true }],
    ['user prompt string', { type: 'user', message: { content: 'hi there' } }, { ...NONE, prompt: 'hi there' }],
    ['user prompt blocks', { type: 'user', message: { content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] } }, { ...NONE, prompt: 'a\nb' }],
    ['user tool_result', { type: 'user', message: { content: [{ type: 'tool_result', content: 'out' }] } }, { ...NONE }],
    ['user interrupt', { type: 'user', message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] } },
      { ...NONE, interrupted: true, prompt: '[Request interrupted by user]' }],
    ['compact summary', { type: 'user', isCompactSummary: true, message: { content: 'summary text' } }, { ...NONE, compactSummary: true, prompt: 'summary text' }],
    ['sidechain assistant end_turn', { type: 'assistant', isSidechain: true, requestId: 'r4', message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'sub' }] } },
      { ...NONE, text: 'sub', isReply: true, rid: 'r4' }],
    ['summary entry', { type: 'summary', summary: 'x' }, { ...NONE }],
  ];
  for (const [label, rec, want] of rows) assert.deepStrictEqual(classify(rec), want, label);
});

test('codex classify table', () => {
  const { classify } = readerFor('codex');
  const rows = [
    ['agent_message', { type: 'event_msg', payload: { type: 'agent_message', message: 'all done' } }, { ...NONE, text: 'all done', isReply: true }],
    ['agent_message with id', { type: 'event_msg', payload: { type: 'agent_message', id: 'm1', message: 'x' } }, { ...NONE, text: 'x', isReply: true, rid: 'm1' }],
    ['task_complete', { type: 'event_msg', payload: { type: 'task_complete' } }, { ...NONE, turnEnd: true }],
    ['token_count', { type: 'event_msg', payload: { type: 'token_count', info: {} } }, { ...NONE, inert: true }],
    ['token_usage_record', { type: 'token_usage_record', usage: {} }, { ...NONE, inert: true }],
    ['user_message', { type: 'event_msg', payload: { type: 'user_message', message: 'q' } }, { ...NONE, prompt: 'q' }],
    ['function_call_output', { type: 'response_item', payload: { type: 'function_call_output', output: 'ls out' } }, { ...NONE, text: 'ls out' }],
    ['response_item function_call', { type: 'response_item', payload: { type: 'function_call', name: 'shell' } }, { ...NONE, inert: true }],
    ['response_item assistant message', { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'reply' }] } },
      { ...NONE, text: 'reply', isReply: true }],
    ['response_item user message', { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'ask' }] } },
      { ...NONE, inert: true, prompt: 'ask' }],
    ['session_meta', { type: 'session_meta', payload: { id: 's1' } }, { ...NONE, rid: 's1' }],
  ];
  for (const [label, rec, want] of rows) assert.deepStrictEqual(classify(rec), want, label);
});

test('sniffReader picks the platform off one record', () => {
  assert.strictEqual(sniffReader(MUSE_MESSAGE).id, 'muse');
  assert.strictEqual(sniffReader(MUSE_FRAME).id, 'muse');
  assert.strictEqual(sniffReader(MUSE_MARKER).id, 'muse');
  assert.strictEqual(sniffReader({ type: 'event_msg', payload: { type: 'agent_message', message: 'x' } }).id, 'codex');
  assert.strictEqual(sniffReader({ type: 'response_item', payload: {} }).id, 'codex');
  assert.strictEqual(sniffReader({ type: 'assistant', message: {} }).id, 'claude');
  assert.strictEqual(sniffReader({ type: 'user', message: {} }).id, 'claude');
  assert.strictEqual(readerFor('nope').id, null);
  assert.deepStrictEqual(readerFor('nope').classify(MUSE_TERMINAL_COMPLETED), { ...NONE, turnEnd: true });
});

function runWatcher(entries, reader) {
  const dir = mkTmpRoot('clodex-watcher-');
  const file = path.join(dir, 'transcript.jsonl');
  fs.writeFileSync(file, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');

  const { JsonlWatcher } = createJsonlWatcher({ REGISTRY_DIR: dir });
  const seen = [];
  const edges = [];
  const w = new JsonlWatcher('seat', (text, touches, meta) => seen.push({ text, meta }), () => {},
    (state, turnEnd) => edges.push([state, turnEnd]), () => {}, () => {}, { reader });
  w._fd = fs.openSync(file, 'r');
  w._position = 0;
  w._readLines();
  w.stop();
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  return { seen, edges };
}

test('muse watcher: message, ten inert records, terminal — exactly one onText, turnEnd true', () => {
  assert.strictEqual(MUSE_INERT_RUN_EVENTS.length, 10);
  const { seen, edges } = runWatcher([MUSE_STARTED, MUSE_MESSAGE, ...MUSE_INERT_RUN_EVENTS, MUSE_TERMINAL_COMPLETED], readerFor('muse'));
  assert.ok(seen.length >= 1, 'ENTER: a flush happened at all — a silent watcher would pass a zero-count check below');
  assert.deepStrictEqual(seen.map((s) => [s.text, s.meta.turnEnd, s.meta.interrupted]), [['echo: say hello', true, false]]);
  assert.deepStrictEqual(edges, [['thinking', false], ['idle', true]]);
});

test('muse watcher: a cancelled terminal flushes the reply interrupted; markers and frames do not flush', () => {
  const { seen } = runWatcher([MUSE_MESSAGE, MUSE_MARKER, MUSE_FRAME, MUSE_TERMINAL_CANCELLED], readerFor('muse'));
  assert.ok(seen.length >= 1, 'ENTER: a flush happened at all');
  assert.deepStrictEqual(seen.map((s) => [s.text, s.meta.turnEnd, s.meta.interrupted]), [['echo: say hello', true, true]]);
});

test('muse watcher: a prompt flushes the pending reply without ending the turn', () => {
  const { seen } = runWatcher([MUSE_MESSAGE, MUSE_PROMPT], readerFor('muse'));
  assert.ok(seen.length >= 1, 'ENTER: a flush happened at all');
  assert.deepStrictEqual(seen.map((s) => [s.text, s.meta.turnEnd, s.meta.interrupted]), [['echo: say hello', false, false]]);
});

test('the watcher without a reader sniffs per record, so a Codex tape still ends its turn on task_complete', () => {
  const { seen } = runWatcher([
    { type: 'event_msg', payload: { type: 'agent_message', message: 'all done' } },
    { type: 'token_usage_record', usage: {} },
    { type: 'event_msg', payload: { type: 'token_count', info: {} } },
    { type: 'event_msg', payload: { type: 'task_complete' } },
  ], undefined);
  assert.deepStrictEqual(seen.map((s) => [s.text, s.meta.turnEnd]), [['all done', true]]);
});
