// Run: node --test
// Covers transcript rendering off CLI JSONL: markdown export, the phone-view
// message extraction (text-only, control-char + delivery-label scrubbing), and
// the per-entry extractText for both Claude and Codex shapes.
const { test } = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const {
  jsonlToMarkdown, extractClaudeBlocks, jsonlToMessages, cachedMessages, sliceSince, extractText,
} = require('../transcript');

function writeJsonl(lines) {
  const p = path.join(os.tmpdir(), `transcript-${process.pid}-${Math.random().toString(36).slice(2)}.jsonl`);
  fs.writeFileSync(p, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  return p;
}

test('extractClaudeBlocks: text, tool_use, tool_result rendering', () => {
  const out = extractClaudeBlocks([
    { type: 'text', text: 'hello' },
    { type: 'tool_use', name: 'Bash' },
    { type: 'tool_result', content: 'result body' },
  ]);
  assert.ok(out.includes('hello'));
  assert.ok(out.includes('🔧 *Used tool: `Bash`*'));
  assert.ok(out.includes('📥 *Tool result:*'));
  assert.ok(out.includes('result body'));
});

test('extractClaudeBlocks: string content passes through, non-array non-string -> empty', () => {
  assert.strictEqual(extractClaudeBlocks('plain'), 'plain');
  assert.strictEqual(extractClaudeBlocks(null), '');
});

test('extractClaudeBlocks: long tool_result is truncated', () => {
  const out = extractClaudeBlocks([{ type: 'tool_result', content: 'x'.repeat(1000) }]);
  assert.ok(out.includes('…[truncated]'));
});

test('jsonlToMarkdown: renders a Claude conversation with a header', () => {
  const p = writeJsonl([
    { type: 'user', message: { content: 'hi there' } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'hello back' }] } },
  ]);
  try {
    const md = jsonlToMarkdown(p, 'claude', 'sess1');
    assert.ok(md.includes('# sess1 — conversation transcript'));
    assert.ok(md.includes('## 👤 User'));
    assert.ok(md.includes('hi there'));
    assert.ok(md.includes('## 🤖 Assistant'));
    assert.ok(md.includes('hello back'));
  } finally { fs.unlinkSync(p); }
});

test('jsonlToMarkdown: renders the Codex event_msg shape', () => {
  const p = writeJsonl([
    { type: 'event_msg', payload: { type: 'user_message', message: 'q' } },
    { type: 'event_msg', payload: { type: 'agent_message', message: 'a' } },
  ]);
  try {
    const md = jsonlToMarkdown(p, 'codex', 'sess2');
    assert.ok(md.includes('👤 User'));
    assert.ok(md.includes('🤖 Assistant'));
    assert.ok(md.includes('q') && md.includes('a'));
  } finally { fs.unlinkSync(p); }
});

test('jsonlToMessages: text-only, drops tool traffic and sidechains', () => {
  const p = writeJsonl([
    { type: 'user', message: { content: 'real question' } },
    { type: 'user', message: { content: [{ type: 'tool_result', content: 'noise' }] } },
    { type: 'assistant', isSidechain: true, message: { content: [{ type: 'text', text: 'sub' }] } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'the answer' }] } },
  ]);
  try {
    const msgs = jsonlToMessages(p);
    assert.deepStrictEqual(msgs.map(m => m.role), ['user', 'assistant']);
    assert.strictEqual(msgs[0].text, 'real question');
    assert.strictEqual(msgs[1].text, 'the answer');
  } finally { fs.unlinkSync(p); }
});

test('jsonlToMessages: scrubs control chars, delivery label, and slash-command echoes', () => {
  const p = writeJsonl([
    { type: 'user', message: { content: '\x15[agent:from user] hi' } },
    { type: 'user', message: { content: '<command-name>/clear</command-name>' } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } },
  ]);
  try {
    const msgs = jsonlToMessages(p);
    // the slash-command echo is emptied out, so only the cleaned user line + reply remain
    assert.strictEqual(msgs[0].text, 'hi');
    assert.strictEqual(msgs[msgs.length - 1].text, 'ok');
  } finally { fs.unlinkSync(p); }
});

test('jsonlToMessages: the delivery label is scrubbed off the Codex event_msg user shape too', () => {
  const p = writeJsonl([
    { type: 'event_msg', payload: { type: 'user_message', message: '\x15[agent:from user] do the thing' } },
    { type: 'event_msg', payload: { type: 'agent_message', message: 'on it' } },
  ]);
  try {
    const msgs = jsonlToMessages(p);
    assert.deepStrictEqual(msgs.map(m => [m.role, m.text]), [
      ['user', 'do the thing'],
      ['assistant', 'on it'],
    ]);
  } finally { fs.unlinkSync(p); }
});

test('jsonlToMessages: the delivery label is scrubbed off the Codex response_item user shape too', () => {
  const p = writeJsonl([
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '\x15[agent:from user] do the thing' }] } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'on it' }] } },
  ]);
  try {
    const msgs = jsonlToMessages(p);
    assert.deepStrictEqual(msgs.map(m => [m.role, m.text]), [
      ['user', 'do the thing'],
      ['assistant', 'on it'],
    ]);
  } finally { fs.unlinkSync(p); }
});

test('jsonlToMessages: a peer label on a Codex user entry keeps rendering', () => {
  const p = writeJsonl([
    { type: 'event_msg', payload: { type: 'user_message', message: '[agent:from reviewer] verdict: accept' } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '[agent:from clodex] ticket t9' }] } },
  ]);
  try {
    assert.deepStrictEqual(jsonlToMessages(p).map(m => m.text), [
      '[agent:from reviewer] verdict: accept\n\n[agent:from clodex] ticket t9',
    ]);
  } finally { fs.unlinkSync(p); }
});

test('jsonlToMessages: an assistant entry quoting the delivery label keeps it', () => {
  const p = writeJsonl([
    { type: 'event_msg', payload: { type: 'user_message', message: 'what did you get?' } },
    { type: 'event_msg', payload: { type: 'agent_message', message: '[agent:from user] was the prefix' } },
    { type: 'assistant', message: { content: [{ type: 'text', text: '[agent:from user] was the prefix' }] } },
  ]);
  try {
    assert.deepStrictEqual(jsonlToMessages(p).map(m => [m.role, m.text]), [
      ['user', 'what did you get?'],
      ['assistant', '[agent:from user] was the prefix\n\n[agent:from user] was the prefix'],
    ]);
  } finally { fs.unlinkSync(p); }
});

test('jsonlToMessages: the user-text cleaning applies after the branch chain, not inside one branch', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'transcript.js'), 'utf-8');
  const body = src.slice(src.indexOf('function jsonlToMessages'), src.indexOf('function cachedMessages'));
  assert.strictEqual((body.match(/cleanUserText\(/g) || []).length, 1,
    'one application point, so a user-producing branch added later cannot miss it');
  assert.ok(body.indexOf('cleanUserText(') > body.lastIndexOf('codexResponseMessage(obj)'),
    'it must run after every branch has assigned role/text, keyed on role');
  assert.strictEqual((src.match(/agent:from user/g) || []).length, 1,
    'the label literal lives in exactly one place');
});

test('jsonlToMessages: a harness task-notification block is not conversation and does not split the reply', () => {
  const p = writeJsonl([
    { type: 'assistant', message: { stop_reason: 'tool_use', content: [{ type: 'text', text: 'checking' }] } },
    { type: 'user', message: { content: [{ type: 'text', text: '<task-notification>\n<task-id>abc</task-id>\n<output-file>/tmp/x</output-file>\nresult body\n</task-notification>' }] } },
    { type: 'assistant', message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] } },
    { type: 'user', message: { content: [{ type: 'text', text: 'thanks <id> placeholder\n<task-notification>\n<task-id>def</task-id>\n</task-notification>' }] } },
  ]);
  try {
    const msgs = jsonlToMessages(p);
    assert.strictEqual(msgs.length, 3);
    assert.deepStrictEqual(msgs.map(m => [m.role, m.text, m.interim]), [
      ['assistant', 'checking', true],
      ['assistant', 'done', false],
      ['user', 'thanks <id> placeholder', false],
    ]);
    assert.deepStrictEqual(msgs.map(m => m.seq), [0, 1, 2]);
  } finally { fs.unlinkSync(p); }
});

test('jsonlToMessages: consecutive same-role entries merge into one bubble', () => {
  const p = writeJsonl([
    { type: 'assistant', message: { content: [{ type: 'text', text: 'part one' }] } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'part two' }] } },
  ]);
  try {
    const msgs = jsonlToMessages(p);
    assert.strictEqual(msgs.length, 1);
    assert.strictEqual(msgs[0].text, 'part one\n\npart two');
    // Neither entry carries a stop_reason and the file ends there, so the turn is
    // still running: the merged bubble is interim.
    assert.strictEqual(msgs[0].interim, true);
  } finally { fs.unlinkSync(p); }
});

test('jsonlToMessages: interim text before a tool call, final text on end_turn', () => {
  const p = writeJsonl([
    { type: 'assistant', message: { stop_reason: 'tool_use', content: [{ type: 'text', text: 'let me check the log' }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', content: 'log body' }] } },
    { type: 'assistant', message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'the log is clean' }] } },
  ]);
  try {
    assert.deepStrictEqual(jsonlToMessages(p).map(m => [m.role, m.text, m.interim]), [
      ['assistant', 'let me check the log', true],
      ['assistant', 'the log is clean', false],
    ]);
  } finally { fs.unlinkSync(p); }
});

test('jsonlToMessages: a running turn — three tool_use texts and no end_turn — is one interim bubble', () => {
  const p = writeJsonl([
    { type: 'assistant', message: { stop_reason: 'tool_use', content: [{ type: 'text', text: 'one' }] } },
    { type: 'assistant', message: { stop_reason: 'tool_use', content: [{ type: 'text', text: 'two' }] } },
    { type: 'assistant', message: { stop_reason: 'tool_use', content: [{ type: 'text', text: 'three' }] } },
  ]);
  try {
    assert.deepStrictEqual(jsonlToMessages(p).map(m => [m.role, m.text, m.interim]), [
      ['assistant', 'one\n\ntwo\n\nthree', true],
    ]);
  } finally { fs.unlinkSync(p); }
});

test('jsonlToMessages: a stop_reason-less tail is final once a genuine user message closes the turn', () => {
  const p = writeJsonl([
    { type: 'assistant', message: { content: [{ type: 'text', text: 'no stop reason here' }] } },
    { type: 'user', message: { content: 'and the next question' } },
  ]);
  try {
    assert.deepStrictEqual(jsonlToMessages(p).map(m => [m.role, m.text, m.interim]), [
      ['assistant', 'no stop reason here', false],
      ['user', 'and the next question', false],
    ]);
  } finally { fs.unlinkSync(p); }
});

test('jsonlToMessages: Codex closes with a text-less task_complete, so only the last agent_message is final', () => {
  const p = writeJsonl([
    { type: 'event_msg', payload: { type: 'agent_message', message: 'first note' } },
    { type: 'event_msg', payload: { type: 'agent_message', message: 'second note' } },
    { type: 'event_msg', payload: { type: 'task_complete' } },
  ]);
  try {
    assert.deepStrictEqual(jsonlToMessages(p).map(m => [m.role, m.text, m.interim]), [
      ['assistant', 'first note', true],
      ['assistant', 'second note', false],
    ]);
  } finally { fs.unlinkSync(p); }
});

test('jsonlToMessages: a tool_result-only user entry does not open a turn', () => {
  const p = writeJsonl([
    { type: 'assistant', message: { stop_reason: 'tool_use', content: [{ type: 'text', text: 'before' }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', content: 'tool traffic' }] } },
    { type: 'assistant', message: { stop_reason: 'tool_use', content: [{ type: 'text', text: 'after' }] } },
  ]);
  try {
    assert.deepStrictEqual(jsonlToMessages(p).map(m => [m.role, m.text, m.interim]), [
      ['assistant', 'before\n\nafter', true],
    ]);
  } finally { fs.unlinkSync(p); }
});

test('jsonlToMessages: respects the limit (keeps the newest)', () => {
  // alternate roles so each entry is its own bubble (same-role entries merge)
  const p = writeJsonl(Array.from({ length: 5 }, (_, i) => (
    i % 2 === 0
      ? { type: 'user', message: { content: `m${i}` } }
      : { type: 'assistant', message: { content: [{ type: 'text', text: `m${i}` }] } }
  )));
  try {
    const msgs = jsonlToMessages(p, 2);
    assert.strictEqual(msgs.length, 2);
    assert.strictEqual(msgs[1].text, 'm4');
  } finally { fs.unlinkSync(p); }
});

function alternatingEntries(n) {
  return Array.from({ length: n }, (_, i) => (
    i % 2 === 0
      ? { type: 'user', message: { content: `m${i}` } }
      : { type: 'assistant', message: { content: [{ type: 'text', text: `m${i}` }] } }
  ));
}

test('jsonlToMessages: seq is the ordinal in the FULL list and survives the tail slice', () => {
  const p = writeJsonl(alternatingEntries(5));
  try {
    assert.deepStrictEqual(jsonlToMessages(p, 2).map(m => m.seq), [3, 4]);
    assert.deepStrictEqual(jsonlToMessages(p, Infinity).map(m => m.seq), [0, 1, 2, 3, 4]);
  } finally { fs.unlinkSync(p); }
});

test('sliceSince: since is INCLUSIVE and the cursor is the start of the last turn', () => {
  const all = [
    { seq: 0, role: 'user' },
    { seq: 1, role: 'assistant' },
    { seq: 2, role: 'assistant' },
    { seq: 3, role: 'user' },
    { seq: 4, role: 'assistant' },
  ];

  const from3 = sliceSince(all, 3, 100);
  assert.deepStrictEqual(from3.messages.map(m => m.seq), [3, 4]);
  assert.strictEqual(from3.cursor, 3);
  assert.strictEqual(from3.complete, true);

  const from5 = sliceSince(all, 5, 100);
  assert.deepStrictEqual(from5.messages, []);
  assert.strictEqual(from5.cursor, 3);

  assert.deepStrictEqual(sliceSince(all, 0, 2).messages.map(m => m.seq), [3, 4]);

  assert.deepStrictEqual(sliceSince(all, null, 2), { messages: [all[3], all[4]], cursor: 3, complete: true });

  assert.deepStrictEqual(sliceSince([], null, 5), { messages: [], cursor: 0, complete: true });
});

test('sliceSince: a tail that re-merges mid-turn is re-sent from the turn start, never skipped', () => {
  const p = writeJsonl([
    { type: 'user', message: { content: 'first' } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'one' }], stop_reason: 'end_turn' } },
    { type: 'user', message: { content: 'hi' } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'thinking' }], stop_reason: 'tool_use' } },
    { type: 'user', message: { content: [{ type: 'tool_result', content: 'x' }] } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'final answer' }], stop_reason: 'end_turn' } },
  ]);
  try {
    const a = jsonlToMessages(p, Infinity);
    assert.strictEqual(a.length, 5);
    assert.strictEqual(sliceSince(a, null, 100).cursor, 2);

    fs.appendFileSync(p, [
      { type: 'user', message: { content: '<system-reminder>injected</system-reminder>' } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'more' }], stop_reason: 'tool_use' } },
    ].map(l => JSON.stringify(l)).join('\n') + '\n');

    const b = jsonlToMessages(p, Infinity);
    assert.strictEqual(b.length, 4);

    const page = sliceSince(b, 2, 100);
    assert.deepStrictEqual(page.messages.map(m => m.seq), [2, 3]);
    assert.strictEqual(page.cursor, 2);
    assert.strictEqual(page.messages[1].text, 'thinking\n\nfinal answer\n\nmore');
    assert.strictEqual(page.messages[1].interim, true);
  } finally { fs.unlinkSync(p); }
});

test('cachedMessages: an unchanged file is not re-parsed; a grown file is', () => {
  const p = writeJsonl(alternatingEntries(3));
  try {
    const a = cachedMessages(p);
    const b = cachedMessages(p);
    assert.strictEqual(a === b, true);

    fs.appendFileSync(p, JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'later' }] } }) + '\n');
    const bumped = new Date(Date.now() + 2000);
    fs.utimesSync(p, bumped, bumped);

    const c = cachedMessages(p);
    assert.strictEqual(c !== a, true);
    assert.strictEqual(c.length, a.length + 1);
  } finally { fs.unlinkSync(p); }
});

test('hello advertises transcript-since and transcript-after, and the endpoint threads both through', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'remote.js'), 'utf-8');
  assert.match(src, /caps = \['transcript', 'transcript-since', 'transcript-after', 'send'\]/);
  assert.match(src, /this\._getTranscript\(name, limit, since, after\)/);

  const remote = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'remote.html'), 'utf-8');
  assert.match(remote, /if \(j\.messages\.length\) \{/);
  assert.doesNotMatch(remote, /!j\.messages\.length \|\|/);
});

test('extractText: Claude assistant text', () => {
  assert.strictEqual(
    extractText({ type: 'assistant', message: { content: [{ type: 'text', text: 'a' }, { type: 'tool_use', name: 'X' }] } }),
    'a');
  assert.strictEqual(extractText({ type: 'assistant', message: { content: 'notarray' } }), '');
});

test('extractText: Codex agent_message and function_call_output', () => {
  assert.strictEqual(extractText({ type: 'event_msg', payload: { type: 'agent_message', message: 'hi' } }), 'hi');
  assert.strictEqual(extractText({ type: 'response_item', payload: { type: 'function_call_output', output: 'out' } }), 'out');
  assert.strictEqual(extractText({ type: 'user', message: { content: 'x' } }), '');
});

// The shape the CURRENT Codex build actually writes. The rollout that lost a
// seat's `[agent:dm]` contains ZERO `agent_message` payloads: every reply is a
// `response_item` `message`, and the same text appears a second time inside an
// `item_completed` `AgentMessage`. Key layout below is copied from that rollout
// (~/.codex/sessions/…-01a078df-…jsonl); only the prose is redacted.
const CODEX_ROLLOUT = [
  {
    timestamp: '2026-09-06T22:39:29.743Z', ordinal: 2, type: 'response_item',
    payload: {
      type: 'message', id: 'msg_dev', role: 'developer',
      content: [{ type: 'input_text', text: '<skills_instructions>injected</skills_instructions>' }],
    },
  },
  {
    timestamp: '2026-09-06T22:39:29.744Z', ordinal: 5, type: 'response_item',
    payload: {
      type: 'message', id: 'msg_user', role: 'user',
      content: [{ type: 'input_text', text: 'the operator question' }],
    },
  },
  {
    timestamp: '2026-09-06T23:07:33.000Z', ordinal: 17, type: 'event_msg',
    payload: {
      type: 'item_completed', thread_id: 't1', turn_id: 'u1',
      item: {
        type: 'AgentMessage', id: 'msg_reply',
        content: [{ type: 'Text', text: '[agent:dm clodex] the audit\n[agent:end]' }],
        phase: 'commentary',
      },
      started_at_ms: 1788734379722, completed_at_ms: 1788734381050,
    },
  },
  {
    timestamp: '2026-09-06T23:07:33.005Z', ordinal: 18, type: 'response_item',
    payload: {
      type: 'message', id: 'msg_reply', role: 'assistant',
      content: [{ type: 'output_text', text: '[agent:dm clodex] the audit\n[agent:end]' }],
      phase: 'commentary',
      internal_chat_message_metadata_passthrough: { turn_id: 'u1' },
    },
  },
];

test('extractText: a Codex response_item assistant message yields its output_text', () => {
  assert.strictEqual(
    extractText(CODEX_ROLLOUT[3]),
    '[agent:dm clodex] the audit\n[agent:end]',
    'the intent line the seat emitted must be what the scanner gets to see');
  assert.strictEqual(
    extractText({
      type: 'response_item',
      payload: {
        type: 'message', role: 'assistant',
        content: [{ type: 'output_text', text: 'one' }, { type: 'output_text', text: 'two' }],
      },
    }),
    'one\ntwo');
});

test('extractText: the item_completed AgentMessage twin yields nothing', () => {
  // Both entries carry the SAME text. Reading both would deliver every Codex
  // intent twice — [agent:task done] twice, [agent:dm] twice.
  assert.strictEqual(extractText(CODEX_ROLLOUT[2]), '');
});

test('extractText: developer and user response_items are not assistant text', () => {
  assert.strictEqual(extractText(CODEX_ROLLOUT[0]), '', 'injected instructions are not a turn');
  assert.strictEqual(extractText(CODEX_ROLLOUT[1]), '', 'the user side is not assistant text');
});

test('jsonlToMarkdown: renders the Codex response_item shape, each reply once', () => {
  const p = writeJsonl(CODEX_ROLLOUT);
  try {
    const md = jsonlToMarkdown(p, 'codex', 'sess3');
    assert.ok(md.includes('the operator question'), 'the user turn must render');
    assert.ok(!md.includes('injected'), 'role:developer must not render as a turn');
    const replies = md.split('[agent:dm clodex] the audit').length - 1;
    assert.strictEqual(replies, 1, 'the AgentMessage twin must not double the reply');
  } finally { fs.unlinkSync(p); }
});

test('jsonlToMessages: the Codex response_item shape becomes one user + one assistant bubble', () => {
  const p = writeJsonl(CODEX_ROLLOUT);
  try {
    const msgs = jsonlToMessages(p);
    // The rollout carries no `task_complete`, so its tail reply is still interim —
    // that is the shape a phone hits mid-turn, not a defect in the fixture.
    assert.deepStrictEqual(msgs.map(m => [m.role, m.text, m.interim]), [
      ['user', 'the operator question', false],
      ['assistant', '[agent:dm clodex] the audit\n[agent:end]', true],
    ]);
  } finally { fs.unlinkSync(p); }
});

const AFTER_ROWS = [
  { seq: 0, role: 'user', ts: '2026-09-17T00:00:00.000Z' },
  { seq: 1, role: 'assistant', ts: '2026-09-17T01:00:00.000Z' },
  { seq: 2, role: 'assistant', ts: null },
  { seq: 3, role: 'user', ts: '2026-09-17T02:00:00.000Z' },
  { seq: 4, role: 'assistant', ts: '2026-09-17T03:00:00.000Z' },
];

test('sliceSince: `after` keeps rows at or newer than the instant, and every null-ts row', () => {
  const page = sliceSince(AFTER_ROWS, null, 100, '2026-09-17T02:00:00.000Z');
  assert.deepStrictEqual(page.messages.map(m => m.seq), [2, 3, 4],
    'the boundary row (seq 3, ts === after) survives, and the null-ts row is never dropped by a time filter');
  assert.strictEqual(page.cursor, 3, 'the cursor still names the last turn start of the FULL history');

  assert.deepStrictEqual(
    sliceSince(AFTER_ROWS, null, 100, '2026-09-17T09:00:00.000Z').messages.map(m => m.seq), [2],
    'an instant past every stamp leaves only the row that carries none');
});

test('sliceSince: the time filter runs BEFORE the limit — a back-dated row cannot displace a survivor', () => {
  const skewed = [
    { seq: 0, ts: '2026-09-17T03:00:00.000Z' },
    { seq: 1, ts: '2026-09-17T04:00:00.000Z' },
    { seq: 2, ts: '2026-09-17T00:30:00.000Z' },
    { seq: 3, ts: '2026-09-17T05:00:00.000Z' },
  ];
  assert.deepStrictEqual(
    sliceSince(skewed, null, 2, '2026-09-17T02:00:00.000Z').messages.map(m => m.seq), [1, 3],
    'the page is the last 2 rows that PASS; slicing first would hand the filter [2,3] and return just [3], losing a row the window should show');
});

test('sliceSince: the limit counts SURVIVORS — a narrow window returns fewer rows than the limit, never a topped-up tail', () => {
  assert.deepStrictEqual(
    sliceSince(AFTER_ROWS, null, 3, '2026-09-17T09:00:00.000Z').messages.map(m => m.seq), [2],
    'one row passes the window, so one row comes back — filtering AFTER the slice would have returned the last 3 rows regardless');
  assert.deepStrictEqual(
    sliceSince(AFTER_ROWS, null, 2, '2026-09-17T01:00:00.000Z').messages.map(m => m.seq), [3, 4],
    'and with more survivors than the limit it is still the NEWEST survivors');
});

test('sliceSince: `after` composes with the seq cursor, and an unparseable instant filters nothing', () => {
  assert.deepStrictEqual(
    sliceSince(AFTER_ROWS, 1, 100, '2026-09-17T02:30:00.000Z').messages.map(m => m.seq), [2, 4],
    'both cursors apply: seq >= 1 drops row 0, the time floor drops rows 1 and 3, and the null-ts row survives between them');
  assert.deepStrictEqual(
    sliceSince(AFTER_ROWS, null, 100, 'not-a-time').messages.map(m => m.seq), [0, 1, 2, 3, 4],
    'a garbage instant is inert here — the ROUTE refuses it with a 400, this layer never silently empties the page');
  assert.deepStrictEqual(
    sliceSince(AFTER_ROWS, null, 100).messages.map(m => m.seq), [0, 1, 2, 3, 4],
    'the default (no `after`) is the pre-t958 behaviour');
});
