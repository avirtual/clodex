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
  jsonlToMarkdown, extractClaudeBlocks, jsonlToMessages, extractText,
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

test('jsonlToMessages: consecutive same-role entries merge into one bubble', () => {
  const p = writeJsonl([
    { type: 'assistant', message: { content: [{ type: 'text', text: 'part one' }] } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'part two' }] } },
  ]);
  try {
    const msgs = jsonlToMessages(p);
    assert.strictEqual(msgs.length, 1);
    assert.strictEqual(msgs[0].text, 'part one\n\npart two');
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
