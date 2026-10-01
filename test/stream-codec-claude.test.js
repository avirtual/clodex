'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { create, decode, encodeUser } = require('../stream-codec-claude');

const LINES = fs.readFileSync(path.join(__dirname, 'fixtures', 'stream-claude', 'control-records.jsonl'), 'utf8')
  .trim().split('\n');

const [CAN_USE_WRITE] = fs.readFileSync(path.join(__dirname, 'fixtures', 'stream-claude', 'permissions.jsonl'), 'utf8')
  .trim().split('\n').map((l) => JSON.parse(l));
const canUse = (request, id = 'req-1') => ({ type: 'control_request', request_id: id, request: { subtype: 'can_use_tool', ...request } });

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
    terminalSlashCommands: ['doctor', 'color', 'focus', 'reload-plugins'],
    pluginErrors: [],
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

test('decode: an init without terminal_slash_commands reports an empty terminal set', () => {
  assert.deepStrictEqual(decode({ type: 'system', subtype: 'init', session_id: 's', slash_commands: ['compact'] }).terminalSlashCommands, []);
});

test('decode: an init carrying the measured 2.1.286 plugin_errors entry keeps it, path preserved', () => {
  const message = 'Failed to load plugin: Plugin clodex-agents has a corrupt manifest file at /tmp/p/.claude-plugin/plugin.json. JSON parse error: Unexpected token';
  const rec = decode({ type: 'system', subtype: 'init', session_id: 's', slash_commands: [],
    plugin_errors: [{ plugin: 'inline[0]', type: 'generic-error', message, path: '/tmp/p' }, null, 'x'] });
  assert.deepStrictEqual(rec.pluginErrors, [{ plugin: 'inline[0]', type: 'generic-error', message, path: '/tmp/p' }]);
});

test('decode: assistant and user content records are not decoded', () => {
  assert.deepStrictEqual(
    [decode({ type: 'assistant', message: { content: [] } }), decode({ type: 'user', message: { content: 'x' } }), decode(null)],
    [{ kind: 'other' }, { kind: 'other' }, { kind: 'other' }]);
});

test('encodeUser builds the stream-json user message', () => {
  assert.deepStrictEqual(encodeUser('hello'), { type: 'user', message: { role: 'user', content: 'hello' } });
});

test('encodeUser with images puts the image blocks first, then one text block', () => {
  assert.deepStrictEqual(encodeUser('what is this', [{ mediaType: 'image/png', data: 'AAAA' }, { mediaType: 'image/jpeg', data: 'BBBB' }]), {
    type: 'user',
    message: {
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'BBBB' } },
        { type: 'text', text: 'what is this' },
      ],
    },
  });
});

test('encodeUser with images and empty text omits the text block; an empty image list keeps string content', () => {
  assert.deepStrictEqual(encodeUser('', [{ mediaType: 'image/gif', data: 'CCCC' }]), {
    type: 'user',
    message: { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/gif', data: 'CCCC' } }] },
  });
  assert.deepStrictEqual(encodeUser(' \n', [{ mediaType: 'image/gif', data: 'CCCC' }]), {
    type: 'user',
    message: { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/gif', data: 'CCCC' } }] },
  });
  assert.deepStrictEqual(encodeUser('hello', []), { type: 'user', message: { role: 'user', content: 'hello' } });
});

test('decode: a can_use_tool control_request is a permission-request with the suggestion as allow-always', () => {
  assert.deepStrictEqual(create().decode(CAN_USE_WRITE), {
    kind: 'permission-request',
    id: '52fcf84f-cb00-4fb3-b393-d0e6ecae1bb7',
    toolName: 'Write',
    displayName: 'Write',
    description: 'hello.txt',
    preview: CAN_USE_WRITE.request.input.file_path,
    input: CAN_USE_WRITE.request.input,
    choices: [
      { id: 'allow', label: 'Allow', kind: 'allow' },
      { id: 'allow-always', label: 'Accept edits for this session', kind: 'allow-always' },
      { id: 'deny', label: 'Deny', kind: 'deny' },
    ],
  });
});

test('decode: preview is the command, path or url the tool acts on, else the description', () => {
  const previews = [
    canUse({ tool_name: 'Bash', input: { command: 'ls -la' }, description: 'List' }),
    canUse({ tool_name: 'Edit', input: { file_path: '/a/b.js' } }),
    canUse({ tool_name: 'NotebookEdit', input: { file_path: '/a/n.ipynb' } }),
    canUse({ tool_name: 'Read', input: { file_path: '/a/r.txt' } }),
    canUse({ tool_name: 'WebFetch', input: { url: 'https://x.test' } }),
    canUse({ tool_name: 'Glob', input: { pattern: '*' }, description: 'Find files' }),
    canUse({ tool_name: 'Glob', input: { pattern: '*' } }),
  ].map((o) => decode(o).preview);
  assert.deepStrictEqual(previews, ['ls -la', '/a/b.js', '/a/n.ipynb', '/a/r.txt', 'https://x.test', 'Find files', null]);
});

test('decode: no suggestions offers allow and deny only; addRules and unknown suggestions label allow-always', () => {
  const kinds = (o) => decode(o).choices.map((c) => c.label);
  assert.deepStrictEqual(kinds(canUse({ tool_name: 'Bash', input: { command: 'x' } })), ['Allow', 'Deny']);
  assert.deepStrictEqual(kinds(canUse({ tool_name: 'Bash', input: { command: 'x' }, permission_suggestions: [] })), ['Allow', 'Deny']);
  assert.deepStrictEqual(kinds(canUse({
    tool_name: 'Bash',
    input: { command: 'npm test' },
    permission_suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }, { toolName: 'Read' }], behavior: 'allow', destination: 'localSettings' }],
  })), ['Allow', 'Always allow Bash(npm test:*), Read', 'Deny']);
  assert.deepStrictEqual(kinds(canUse({ tool_name: 'Bash', input: {}, permission_suggestions: [{ type: 'addDirectories' }] })), ['Allow', 'Always allow', 'Deny']);
  const bare = decode(canUse({ tool_name: 'Glob' }));
  assert.deepStrictEqual([bare.displayName, bare.description, bare.input], ['Glob', null, null]);
});

test('decode: any other control_request subtype is other', () => {
  assert.deepStrictEqual(decode({ type: 'control_request', request_id: 'r', request: { subtype: 'hook_callback' } }), { kind: 'other' });
});

test('encodePermission answers allow, allow-always and deny in the control_response shape, once per id', () => {
  const input = CAN_USE_WRITE.request.input;
  const id = CAN_USE_WRITE.request_id;
  const wrap = (response) => ({ type: 'control_response', response: { subtype: 'success', request_id: id, response } });
  const rows = [
    ['allow', { behavior: 'allow', updatedInput: input }],
    ['allow-always', { behavior: 'allow', updatedInput: input, updatedPermissions: CAN_USE_WRITE.request.permission_suggestions }],
    ['deny', { behavior: 'deny', message: 'Denied by the operator in Clodex.' }],
  ];
  for (const [choiceId, response] of rows) {
    const codec = create();
    codec.decode(CAN_USE_WRITE);
    assert.deepStrictEqual(codec.encodePermission(id, choiceId), wrap(response), choiceId);
    assert.strictEqual(codec.encodePermission(id, choiceId), null, `${choiceId}: an answered id is no longer pending`);
  }
});

test('encodePermission is null for an unknown id or a choice the request did not offer', () => {
  const codec = create();
  codec.decode(canUse({ tool_name: 'Bash', input: { command: 'x' } }, 'r-bash'));
  assert.strictEqual(codec.encodePermission('nope', 'allow'), null);
  assert.strictEqual(codec.encodePermission('r-bash', 'allow-always'), null);
  assert.strictEqual(codec.encodePermission('r-bash', 'bogus'), null);
  assert.deepStrictEqual(codec.encodePermission('r-bash', 'deny').response.request_id, 'r-bash');
});

test('a result or an init drops pending requests without answering them', () => {
  for (const idx of [0, 1]) {
    const codec = create();
    codec.decode(CAN_USE_WRITE);
    assert.ok(['init', 'result'].includes(codec.decode(JSON.parse(LINES[idx])).kind));
    assert.strictEqual(codec.encodePermission(CAN_USE_WRITE.request_id, 'allow'), null);
  }
});

test('create() carries the module encodeUser and the same decode records', () => {
  const codec = create({ cwd: '/w' });
  assert.strictEqual(codec.encodeUser, encodeUser);
  assert.deepStrictEqual(codec.decode(JSON.parse(LINES[7])), { kind: 'permission-denied', toolName: 'Write' });
});

test('encodeInterrupt is an interrupt control_request with a fresh request id per call', () => {
  const codec = create();
  assert.deepStrictEqual(codec.encodeInterrupt(), { type: 'control_request', request_id: 'clodex-interrupt-1', request: { subtype: 'interrupt' } });
  assert.deepStrictEqual(codec.encodeInterrupt(), { type: 'control_request', request_id: 'clodex-interrupt-2', request: { subtype: 'interrupt' } });
});

test('decode: the control_response acknowledging an interrupt is other and keeps pending requests', () => {
  const codec = create();
  codec.decode(CAN_USE_WRITE);
  const ack = { type: 'control_response', response: { subtype: 'success', request_id: 'clodex-interrupt-1', response: { still_queued: [] } } };
  assert.deepStrictEqual(codec.decode(ack), { kind: 'other' });
  assert.ok(codec.encodePermission(CAN_USE_WRITE.request_id, 'deny'));
});

test('encodeSetModel is a set_model control_request with a fresh request id per call', () => {
  const codec = create();
  assert.deepStrictEqual(codec.encodeSetModel('claude-sonnet-4-6'), { type: 'control_request', request_id: 'clodex-set-model-1', request: { subtype: 'set_model', model: 'claude-sonnet-4-6' } });
  assert.deepStrictEqual(codec.encodeSetModel('claude-haiku-4-5'), { type: 'control_request', request_id: 'clodex-set-model-2', request: { subtype: 'set_model', model: 'claude-haiku-4-5' } });
});

test('decode: a control_response for a sent set_model is a control-ack, once; an unknown id stays other', () => {
  const codec = create();
  const ok = codec.encodeSetModel('claude-sonnet-4-6');
  const bad = codec.encodeSetModel('claude-nope-1');
  const success = { type: 'control_response', response: { subtype: 'success', request_id: ok.request_id } };
  const error = { type: 'control_response', response: { subtype: 'error', request_id: bad.request_id, error: "Model 'claude-nope-1' not found", error_code: 'catalog_unknown' } };
  assert.deepStrictEqual(codec.decode(success), { kind: 'control-ack', id: 'clodex-set-model-1', ok: true, error: null, errorCode: null });
  assert.deepStrictEqual(codec.decode(error), { kind: 'control-ack', id: 'clodex-set-model-2', ok: false, error: "Model 'claude-nope-1' not found", errorCode: 'catalog_unknown' });
  assert.deepStrictEqual(codec.decode(success), { kind: 'other' });
  assert.deepStrictEqual(codec.decode({ type: 'control_response', response: { subtype: 'success', request_id: 'clodex-set-model-9' } }), { kind: 'other' });
});
