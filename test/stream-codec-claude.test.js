'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { decode, encodeUser } = require('../stream-codec-claude');

const LINES = fs.readFileSync(path.join(__dirname, 'fixtures', 'stream-claude', 'control-records.jsonl'), 'utf8')
  .trim().split('\n');

const INIT_SLASH = [
    'design', 'design-sync', 'dataviz', 'update-config', 'debug', 'batch',
    'fewer-permission-prompts', 'doctor', 'loop', 'schedule', 'run', 'run-skill-generator',
    'advisor', 'agents', 'auto-mode-setup', 'autocompact', 'clear', 'color', 'compact', 'config',
    'output-style', 'context', 'effort', 'fast', 'focus', 'heapdump', 'init', 'mcp', 'import',
    'model', '__remote-workflow', 'workflow-launch-exec', 'reload-plugins', 'reload-skills',
    'rename', 'ultrareview', 'usage-credits', 'extra-usage', 'usage', 'insights', 'recap',
    'skill-doctor', 'goal', 'design-consent', 'design-revoke', 'list-agents', 'team-onboarding',
    'anthropic-skills:built-in-browser', 'anthropic-skills:chrome-browser',
    'anthropic-skills:computer-use', 'anthropic-skills:deep-research', 'anthropic-skills:docs',
    'anthropic-skills:docx', 'anthropic-skills:exam-trainer', 'anthropic-skills:import-memory',
    'anthropic-skills:mcp-builder', 'anthropic-skills:morning', 'anthropic-skills:pdf',
    'anthropic-skills:pptx', 'anthropic-skills:skill-creator',
    'anthropic-skills:web-artifacts-builder', 'anthropic-skills:xlsx',
];

const ROWS = [
  ['system/init', 0, {
    kind: 'init', sessionId: 'cc887621-34fe-485b-a555-12bddec12af1', model: 'claude-haiku-4-5-20251001',
    slashCommands: INIT_SLASH,
  }],
  ['result/success', 1, { kind: 'result', durationMs: 1330, costUsd: 0.008299500000000001, isError: false }],
  ['result/error_during_execution', 2, { kind: 'result', durationMs: 0, costUsd: 0, isError: true }],
  ['conversation_reset', 3, { kind: 'reset', newConversationId: 'f4e5ec04-01f1-4123-90ad-00452a8e350e' }],
  ['system/compact_boundary', 4, { kind: 'compact', pre: 15292, post: 1383 }],
  ['system/status compacting', 5, { kind: 'status', status: 'compacting' }],
  ['system/status null', 6, { kind: 'status', status: null }],
  ['system/permission_denied', 7, { kind: 'permission-denied', toolName: 'Write' }],
  ['rate_limit_event', 8, { kind: 'other' }],
  ['control_response', 9, { kind: 'other' }],
];

test('ENTER: the fixture holds one real run line per row', () => {
  assert.strictEqual(LINES.length, ROWS.length);
});

for (const [label, idx, want] of ROWS) {
  test(`decode: ${label}`, () => {
    assert.deepStrictEqual(decode(JSON.parse(LINES[idx])), want);
  });
}

test('decode: assistant and user content records are not decoded', () => {
  assert.deepStrictEqual(
    [decode({ type: 'assistant', message: { content: [] } }), decode({ type: 'user', message: { content: 'x' } }), decode(null)],
    [{ kind: 'other' }, { kind: 'other' }, { kind: 'other' }]);
});

test('encodeUser builds the stream-json user message', () => {
  assert.deepStrictEqual(encodeUser('hello'), { type: 'user', message: { role: 'user', content: 'hello' } });
});
