'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { RECORD_CAP, PROMPT_CAP, PROSE_CAP, IMAGE_CAP, recordsOf, segmentsOf, isInternalRow, ticketOf } = require('../transcript-records');

const FIXTURES = path.join(__dirname, 'fixtures', 'transcript-records');
const fixture = (name) => fs.readFileSync(path.join(FIXTURES, `${name}.jsonl`), 'utf8');
const rec = (o) => JSON.stringify(o);

const BASH_PLAIN = { interrupted: false, background: false, persisted: null };

const ROWS = [
  ['a Bash success with one short output line carries it as only', 'bash-ok', [{
    id: 'toolu_01Adbs7yzWMhKVXywkHPLaJJ', kind: 'tool', ts: 1789988805620, turn: 0, name: 'Bash', arg: 'wc -l docs/DESIGN.md', state: 'ok', desc: 'Confirm line budget and that the project tree is untouched',
    sum: { exit: 0, lines: 1, ...BASH_PLAIN, only: '210 docs/DESIGN.md' },
  }]],
  ['a Bash Exit code 1 with a string toolUseResult parses the exit and counts the lines after it', 'bash-exit', [{
    id: 'toolu_01G7QbzNV7SDUYafrQeJaQhC', kind: 'tool', ts: 1790229197666, turn: 0, name: 'Bash', arg: 'ls docs/tasks | tail -3; grep -rl t1129 docs/tasks | head -1', state: 'error', desc: 'Find the record and check the t1129 spec body',
    sum: { exit: 1, lines: 3, ...BASH_PLAIN, only: null },
  }]],
  ['a <tool_use_error> block is an error whose message is its first line, tag stripped', 'tool-use-error', [{
    id: 'toolu_01W1VArV7gi4UjNMb4TBVDA3', kind: 'tool', ts: 1790196151640, turn: 0, name: 'Bash',
    arg: 'sleep 240; tail -1 /repo/tmp/publish-image-5.86.0.log | cut -c1-120; pgrep -f publish-image.sh >/dev/null && echo "publish running" || (echo "publish finished";',
    state: 'error', desc: 'Wait and check whether the image publish has finished and the 5.86.0 tag exists',
    sum: { message: 'Blocked: sleep 240 followed by: tail -1 /repo/tmp/publish-image-5.86.0.log cut -c1-120 pgrep -f publish-image.sh echo "publish running" (echo "p' },
  }]],
  ['a persisted Bash output carries persistedOutputSize', 'bash-persisted', [{
    id: 'toolu_016k76JcCfDUrAUxz5VDiNS6', kind: 'tool', ts: 1790236042638, turn: 0, name: 'Bash', arg: 'cat docs/explorations/transcript-view.md docs/explorations/split-proof.md', state: 'ok',
    sum: { exit: 0, lines: 7, interrupted: false, background: false, persisted: 47860, only: null },
  }]],
  ['an Edit counts the + and - lines of its structuredPatch', 'edit', [{
    id: 'toolu_01C5aBXJFJzywfzJkRooUcAL', kind: 'tool', ts: 1789325907112, turn: 0, name: 'Edit', arg: '/repo/scripts/launch.sh', state: 'ok',
    sum: { file: '/repo/scripts/launch.sh', add: 1, del: 1 },
  }]],
  ['a Write create counts its content lines as added', 'write-create', [{
    id: 'toolu_01JTjcFdo2LRJnzgrDL9si5X', kind: 'tool', ts: 1790236504366, turn: 0, name: 'Write', arg: '/repo/docs/explorations/pane-app-view.md', state: 'ok',
    sum: { file: '/repo/docs/explorations/pane-app-view.md', created: true, add: 5, del: 0 },
  }]],
  ['a Read carries its line range and the file total', 'read', [{
    id: 'toolu_01XstYRVbzi1UCL8pybp4hwg', kind: 'tool', ts: 1789937223304, turn: 0, name: 'Read', arg: '/repo/session-manager.js', state: 'ok',
    sum: { file: '/repo/session-manager.js', from: 6500, to: 7099, total: 8340 },
  }]],
  ['a typed prompt starts a turn; its prose and an unanswered tool_use (pending) inherit it', 'prompt', [
    { id: '243a9c96-5908-494b-b5de-859b8df3a132', kind: 'prompt', ts: 1790198816578, turn: 1, text: 'relaunches what? clodex?', source: 'typed' },
    { id: '9dc0fbdb-80b1-4001-a235-8abcbb6d7121', kind: 'assistant', ts: 1790198989384, turn: 1, text: 'The seat is live and holds the spec. Nothing to do until the report or the reminder arrives.' },
    { id: 'toolu_01VebZHpqp5EaC69antqE5Fo', kind: 'tool', ts: 1789488387041, turn: 1, name: 'Grep', arg: '/repo/peer-client.js', state: 'pending', sum: null },
  ]],
  ['an inbound delivery is a sender card with its attachment path and size', 'inbound', [{
    id: 'ad643390-44b6-4bab-8ef2-71bed3954517', kind: 'inbound', ts: 1790199337313, turn: 1, from: 'wirescope',
    text: 'Message (1569 bytes) attached: @/repo/tmp/msg-35544-6.txt', attached: { path: '/repo/tmp/msg-35544-6.txt', bytes: 1569 },
  }]],
  ['a task notification starts a turn and reads its summary tag', 'notification', [{
    id: '83f269a5-0297-43ea-9cd9-b01f9d896722', kind: 'notification', ts: 1790229144666, turn: 1, text: 'Agent "Survey terminal highlighting helpers" finished',
  }]],
  ['a compact boundary carries its trigger and token counts; the compact summary record is not a row', 'compact', [{
    id: '274aa083-fe20-4c40-b35c-c85fd2cdab56', kind: 'boundary', ts: 1790226815132, turn: 0, what: 'compact', trigger: 'manual', preTokens: 209703, postTokens: 7870,
  }]],
  ['a turn_duration becomes a turn-end', 'turn-duration', [{
    id: '049fa266-9353-472d-b84f-bd94b922716f', kind: 'turn-end', ts: 1790198758874, turn: 0, durationMs: 201184, messageCount: 81,
  }]],
];

for (const [name, file, expected] of ROWS) {
  test(`fixture ${file}: ${name}`, () => {
    const { records } = recordsOf(fixture(file));
    assert.deepStrictEqual(records, expected);
    assert.doesNotMatch(JSON.stringify(records), /originalFile/);
  });
}

const PLATFORM_ROWS = [
  ['a muse accepted user intent is a typed prompt from its refill_blocks', 'muse-intent', /"payload_type":"runtime\.user_intent\.accepted"/, [
    { id: 'cd97be52-9b71-41c4-b87f-cda3a0655d3e', kind: 'prompt', ts: 1790355829993, turn: 1, text: 'what model are you?', source: 'typed' },
  ]],
  ['a muse assistant_message_committed is an assistant row keyed by its message_id', 'muse-reply', /"kind":"assistant_message_committed"/, [
    { id: '1ad13435-28fa-486d-9f92-f44a561f177a', kind: 'assistant', ts: 1790355833129, turn: 0, text: "I'm Muse Code powered by Meta Muse Spark." },
  ]],
  ['a muse terminal event is a turn-end carrying turn_duration_ms', 'muse-terminal', /"kind":"terminal"/, [
    { id: '1f300194-d519-4152-b815-3ff265a59094', kind: 'turn-end', ts: 1790355833271, turn: 0, durationMs: 3182, messageCount: null },
  ]],
  ['a muse retained_frame is unwrapped: permission children yield nothing, a committed message child is its assistant row', 'muse-frame', /"retained_frame":"session_permission_transaction"/, [
    { id: '1ad13435-28fa-486d-9f92-f44a561f177a', kind: 'assistant', ts: 1790355833129, turn: 0, text: "I'm Muse Code powered by Meta Muse Spark." },
  ]],
  ['a codex user response_item message is a typed prompt', 'codex-user', /"type":"response_item".*"role":"user"/, [
    { id: 'msg_01a0d988-bf31-79f0-9416-45ccf176459b', kind: 'prompt', ts: 1790356012850, turn: 1, text: 'there?', source: 'typed' },
  ]],
  ['a codex assistant response_item message is an assistant row', 'codex-assistant', /"type":"response_item".*"role":"assistant"/, [
    { id: 'msg_0f3b29233db1b3c9016ab6aa32ac3887d2852fccb9fa7369bb', kind: 'assistant', ts: 1790356019052, turn: 0, text: 'Here. Ready to review.' },
  ]],
  ['a Claude line keeps the records it produced before the platform readers', 'inbound', /"type":"user"/, [{
    id: 'ad643390-44b6-4bab-8ef2-71bed3954517', kind: 'inbound', ts: 1790199337313, turn: 1, from: 'wirescope',
    text: 'Message (1569 bytes) attached: @/repo/tmp/msg-35544-6.txt', attached: { path: '/repo/tmp/msg-35544-6.txt', bytes: 1569 },
  }]],
];

for (const [name, file, shape, expected] of PLATFORM_ROWS) {
  test(`platform fixture ${file}: ${name}`, () => {
    assert.match(fixture(file), shape, 'ENTER: the fixture carries the platform shape it names');
    assert.deepStrictEqual(recordsOf(fixture(file)).records, expected);
  });
}

test('a muse turn read whole orders prompt, reply and turn-end in one turn', () => {
  const text = ['muse-intent', 'muse-reply', 'muse-terminal'].map(fixture).join('');
  assert.deepStrictEqual(recordsOf(text).records.map((r) => [r.kind, r.turn]), [['prompt', 1], ['assistant', 1], ['turn-end', 1]]);
});

test('a muse command.invoked between prompt and reply is a command row on its own turn', () => {
  const command = rec({
    schema_version: 1, id: 'cmd-84', sequence: 84, recorded_at: 1790355830500000, record_type: 'event',
    payload_type: 'command.invoked', payload_schema_version: 1,
    payload: { kind: 'command_invoked', record: { schema_version: 1, session_id: '01a0d9b9-7ffc-7113-a4d9-4768bbf19388', command: '/model' } },
  });
  const text = [fixture('muse-intent'), `${command}\n`, fixture('muse-reply'), fixture('muse-terminal')].join('');
  assert.deepStrictEqual(recordsOf(text).records, [
    { id: 'cd97be52-9b71-41c4-b87f-cda3a0655d3e', kind: 'prompt', ts: 1790355829993, turn: 1, text: 'what model are you?', source: 'typed' },
    { id: 'cmd-84', kind: 'command', ts: 1790355830500, turn: 2, name: '/model', args: '' },
    { id: '1ad13435-28fa-486d-9f92-f44a561f177a', kind: 'assistant', ts: 1790355833129, turn: 2, text: "I'm Muse Code powered by Meta Muse Spark." },
    { id: '1f300194-d519-4152-b815-3ff265a59094', kind: 'turn-end', ts: 1790355833271, turn: 2, durationMs: 3182, messageCount: null },
  ]);
});

test('a codex event_msg user_message or agent_message is no row: the response_item carries the same text', () => {
  const lines = [
    rec({ timestamp: '2026-09-25T17:06:52.850Z', type: 'event_msg', payload: { type: 'user_message', message: 'there?' } }),
    rec({ timestamp: '2026-09-25T17:06:59.052Z', type: 'event_msg', payload: { type: 'agent_message', message: 'Here.' } }),
  ].join('\n');
  assert.deepStrictEqual(recordsOf(lines).records, []);
});

test('a codex task_complete is a turn-end with no duration', () => {
  const line = rec({ timestamp: '2026-09-25T17:07:00.000Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 't1' } });
  assert.deepStrictEqual(recordsOf(line).records.map((r) => [r.kind, r.durationMs, r.ts]), [['turn-end', null, 1790356020000]]);
});

test('ENTER: the Edit fixture really carries an originalFile, so its absence from the record is a drop', () => {
  assert.match(fixture('edit'), /"originalFile":"x\\n"/);
});

test('local_command records become command and command-output records; a command starts a turn', () => {
  const { records } = recordsOf([
    rec({ type: 'system', subtype: 'local_command', uuid: 'c1', content: '<command-name>/cost</command-name>\n  <command-args>--all </command-args>' }),
    rec({ type: 'system', subtype: 'local_command', uuid: 'c2', content: '<local-command-stdout>\n  Total cost: $1\n</local-command-stdout>' }),
    rec({ type: 'system', subtype: 'local_command', uuid: 'c3', content: '<local-command-stdout></local-command-stdout>' }),
  ].join('\n'));
  assert.deepStrictEqual(records, [
    { id: 'c1', kind: 'command', ts: null, turn: 1, name: '/cost', args: '--all' },
    { id: 'c2', kind: 'command-output', ts: null, turn: 1, text: 'Total cost: $1' },
  ]);
});

const typed = (uuid, promptId, content) => rec({ type: 'user', uuid, promptId, message: { role: 'user', content } });

test('a typed /compact echoed back as <command-name> is no prompt row; the boundary keeps turn 0 because no turn-opening record precedes it', () => {
  const { records } = recordsOf([
    typed('p1', 'P', '/compact'),
    typed('p2', 'P', '<command-name>/compact</command-name>\n<command-message>compact</command-message>\n<command-args></command-args>'),
    typed('p3', 'P', '<local-command-stdout>Compacted (ctrl+o to see full summary)</local-command-stdout>'),
    rec({ type: 'system', subtype: 'compact_boundary', uuid: 'b1', compactMetadata: { trigger: 'manual', preTokens: 100, postTokens: 10 } }),
  ].join('\n'));
  assert.deepStrictEqual(records, [
    { id: 'b1', kind: 'boundary', ts: null, turn: 0, what: 'compact', trigger: 'manual', preTokens: 100, postTokens: 10 },
  ]);
  assert.doesNotMatch(JSON.stringify(records), /\/compact/);
});

test('a /compact-shaped prompt with no echo after it stays a typed prompt row', () => {
  const { records } = recordsOf([
    typed('p1', 'P', '/compact'),
    typed('p2', 'Q', 'next thing'),
  ].join('\n'));
  assert.deepStrictEqual(records, [
    { id: 'p1', kind: 'prompt', ts: null, turn: 1, text: '/compact', source: 'typed' },
    { id: 'p2', kind: 'prompt', ts: null, turn: 2, text: 'next thing', source: 'typed' },
  ]);
});

test('a typed /cost with args echoed as <command-name> loses its prompt row and the tagged lines still produce nothing', () => {
  const { records } = recordsOf([
    typed('p1', 'P', '/cost --all'),
    typed('p2', 'P', '<command-name>/cost</command-name>\n<command-args>--all</command-args>'),
    typed('p3', 'P', '<local-command-stdout>Total cost: $1</local-command-stdout>'),
  ].join('\n'));
  assert.deepStrictEqual(records, []);
});

test('ENTER: the /compact fixture really carries a plain /compact prompt line, so its absence from the records is a removal', () => {
  const { records } = recordsOf(typed('p1', 'P', '/compact'));
  assert.deepStrictEqual(records.map((r) => r.kind), ['prompt']);
});

test('meta, sidechain, attachment, bookkeeping and orphan tool_result records produce nothing', () => {
  const { records } = recordsOf([
    rec({ type: 'user', uuid: 'm', isMeta: true, message: { content: 'meta' } }),
    rec({ type: 'user', uuid: 's', isSidechain: true, message: { content: 'sub' } }),
    rec({ type: 'attachment', uuid: 'a', attachment: { type: 'x' } }),
    rec({ type: 'attachment', uuid: 'n', attachment: { type: 'queued_command', origin: null, commandMode: 'task-notification', prompt: 'done' }, rendered: null }),
    rec({ type: 'ai-title', uuid: 't', aiTitle: 'x' }),
    rec({ type: 'user', uuid: 'o', message: { content: [{ type: 'tool_result', tool_use_id: 'gone', content: 'x' }] } }),
    rec({ type: 'user', uuid: 'x', message: { content: '<local-command-caveat>x</local-command-caveat>' } }),
    'not json',
  ].join('\n'));
  assert.deepStrictEqual(records, []);
});

test('ENTER: the origin-less plain-text queued_command fixture parses to a prompt once the origin is human', () => {
  const { records } = recordsOf(rec({ type: 'attachment', uuid: 'n', attachment: { type: 'queued_command', origin: { kind: 'human' }, commandMode: 'task-notification', prompt: 'done' }, rendered: null }));
  assert.deepStrictEqual(records.map((r) => [r.kind, r.text]), [['prompt', 'done']]);
});

test('an assistant record with two text blocks suffixes each id with its block index; thinking yields nothing', () => {
  const { records } = recordsOf(rec({ type: 'assistant', uuid: 'u1', message: { content: [
    { type: 'thinking', thinking: 'hidden' }, { type: 'text', text: 'one' }, { type: 'text', text: ' two ' },
  ] } }));
  assert.deepStrictEqual(records, [
    { id: 'u1:1', kind: 'assistant', ts: null, turn: 0, text: 'one' },
    { id: 'u1:2', kind: 'assistant', ts: null, turn: 0, text: 'two' },
  ]);
});

test('an API error record is flagged apiError; an interrupt is a warning notice; informational is a notice', () => {
  const { records } = recordsOf([
    rec({ type: 'assistant', uuid: 'e', isApiErrorMessage: true, message: { content: [{ type: 'text', text: 'API Error: 500' }] } }),
    rec({ type: 'user', uuid: 'i', message: { content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] } }),
    rec({ type: 'system', subtype: 'informational', uuid: 'n', level: 'notice', content: 'Safeguards stopped the response' }),
  ].join('\n'));
  assert.deepStrictEqual(records, [
    { id: 'e', kind: 'assistant', ts: null, turn: 0, text: 'API Error: 500', apiError: true },
    { id: 'i', kind: 'notice', ts: null, turn: 0, level: 'warning', text: 'Request interrupted by user for tool use' },
    { id: 'n', kind: 'notice', ts: null, turn: 0, level: 'info', text: 'Safeguards stopped the response' },
  ]);
});

test('a permission rejection is denied; an interrupted Bash is interrupted; an unknown tool counts result lines', () => {
  const use = (id, name, input) => rec({ type: 'assistant', uuid: `a-${id}`, message: { content: [{ type: 'tool_use', id, name, input }] } });
  const result = (id, content, { tur, ...block } = {}) => rec({ type: 'user', uuid: `r-${id}`, message: { content: [{ type: 'tool_result', tool_use_id: id, content, ...block }] }, ...(tur ? { toolUseResult: tur } : {}) });
  const { records } = recordsOf([
    use('d', 'Bash', { command: 'rm x' }),
    result('d', "The user doesn't want to proceed with this tool use. The tool use was rejected.", { is_error: true }),
    use('i', 'Bash', { command: 'make' }),
    result('i', 'partial', { tur: { stdout: 'a\nb\n', stderr: '', interrupted: true } }),
    use('k', 'SendMessage', { to: 'x' }),
    result('k', 'one\ntwo'),
  ].join('\n'));
  assert.deepStrictEqual(records, [
    { id: 'd', kind: 'tool', ts: null, turn: 0, name: 'Bash', arg: 'rm x', state: 'denied', sum: { message: "The user doesn't want to proceed with this tool use. The tool use was rejected." } },
    { id: 'i', kind: 'tool', ts: null, turn: 0, name: 'Bash', arg: 'make', state: 'interrupted', sum: { exit: 0, lines: 2, interrupted: true, background: false, persisted: null, only: null } },
    { id: 'k', kind: 'tool', ts: null, turn: 0, name: 'SendMessage', arg: '{"to":"x"}', state: 'ok', sum: { lines: 2 } },
  ]);
});

test(`a prompt over ${PROMPT_CAP} characters is capped and marked truncated; a queued prompt says so`, () => {
  const { records } = recordsOf([
    rec({ type: 'user', uuid: 'p1', message: { content: 'x'.repeat(PROMPT_CAP + 3) } }),
    rec({ type: 'user', uuid: 'p2', promptSource: 'queued', message: { content: 'later' } }),
  ].join('\n'));
  assert.deepStrictEqual(records, [
    { id: 'p1', kind: 'prompt', ts: null, turn: 1, text: 'x'.repeat(PROMPT_CAP), truncated: true, source: 'typed' },
    { id: 'p2', kind: 'prompt', ts: null, turn: 2, text: 'later', source: 'queued' },
  ]);
});

const paste = (id, body) => `<pasted_content id="${id}">\n${body}\n</pasted_content id="${id}">\n`;
const promptOf = (content) => recordsOf(rec({ type: 'user', uuid: 'u', message: { content } })).records;

test('a typed intro, a blank line and a pasted block make one prompt whose text carries the marker and whose pastes carry the body', () => {
  assert.deepStrictEqual(promptOf(`look at this\n\n${paste('2c29', 'one\ntwo\nthree')}`), [
    { id: 'u', kind: 'prompt', ts: null, turn: 1, text: 'look at this\n[Pasted text #1 +3 lines]', source: 'typed', pastes: [{ n: 1, lines: 3, text: 'one\ntwo\nthree' }] },
  ]);
});

test('a prompt that is only a pasted block is just the marker', () => {
  assert.deepStrictEqual(promptOf(paste('a1', 'x\ny')), [
    { id: 'u', kind: 'prompt', ts: null, turn: 1, text: '[Pasted text #1 +2 lines]', source: 'typed', pastes: [{ n: 1, lines: 2, text: 'x\ny' }] },
  ]);
});

test('two pasted blocks with different ids are numbered in order; a close tag without the id still closes', () => {
  const content = `first\n\n<pasted_content id="aa">\nA\n</pasted_content>\n\nthen\n\n${paste('bb', 'B1\nB2')}`;
  assert.deepStrictEqual(promptOf(content), [
    { id: 'u', kind: 'prompt', ts: null, turn: 1, text: 'first\n[Pasted text #1 +1 lines]\nthen\n[Pasted text #2 +2 lines]', source: 'typed', pastes: [{ n: 1, lines: 1, text: 'A' }, { n: 2, lines: 2, text: 'B1\nB2' }] },
  ]);
});

test('a paste longer than PROMPT_CAP does not truncate the typed text and is kept whole under PROSE_CAP', () => {
  const big = 'y'.repeat(5000);
  const [r] = promptOf(`${'i'.repeat(30)}\n\n${paste('c3', big)}`);
  assert.ok(big.length > PROMPT_CAP && big.length < PROSE_CAP);
  assert.strictEqual(r.truncated, undefined);
  assert.strictEqual(r.text, `${'i'.repeat(30)}\n[Pasted text #1 +1 lines]`);
  assert.deepStrictEqual(r.pastes, [{ n: 1, lines: 1, text: big }]);
});

const image = (data, mediaType = 'image/png') => ({ type: 'image', source: { type: 'base64', media_type: mediaType, data } });

test('a prompt with a pasted image block carries it in images, numbered like its marker', () => {
  assert.deepStrictEqual(promptOf([{ type: 'text', text: '[Image #1]look at this' }, image('iVBORw0KGgo=')]), [
    { id: 'u', kind: 'prompt', ts: null, turn: 1, text: '[Image #1]look at this', source: 'typed', images: [{ n: 1, mediaType: 'image/png', data: 'iVBORw0KGgo=' }] },
  ]);
});

test('an image block takes its n from the marker the composer wrote, not its position in the entry', () => {
  const [r] = promptOf([{ type: 'text', text: '[Image #3]the filter' }, image('AAAA')]);
  assert.deepStrictEqual(r.images, [{ n: 3, mediaType: 'image/png', data: 'AAAA' }]);
});

test('an image over the cap ships its decoded size and no data', () => {
  const big = 'A'.repeat(((IMAGE_CAP + 2) / 3) * 4);
  const [r] = promptOf([{ type: 'text', text: '[Image #1]' }, image(big, 'image/jpeg')]);
  assert.deepStrictEqual(r.images, [{ n: 1, mediaType: 'image/jpeg', bytes: IMAGE_CAP + 2 }]);
});

test('the cap is on the decoded size: an image whose base64 passes 1 MB but whose bytes do not still ships its data', () => {
  const data = 'A'.repeat(IMAGE_CAP + 4);
  const [r] = promptOf([{ type: 'text', text: '[Image #1]' }, image(data)]);
  assert.deepStrictEqual(r.images, [{ n: 1, mediaType: 'image/png', data }]);
});

test('a repeated marker numbers one image, so two blocks under [Image #1] [Image #1] [Image #2] are n 1 and n 2', () => {
  const [r] = promptOf([{ type: 'text', text: '[Image #1] a [Image #1] b [Image #2]' }, image('AAAA'), image('BBBB')]);
  assert.deepStrictEqual(r.images.map((i) => [i.n, i.data]), [[1, 'AAAA'], [2, 'BBBB']]);
});

test('image blocks beyond the markers are not shipped', () => {
  const [r] = promptOf([{ type: 'text', text: '[Image #3] only one' }, image('AAAA'), image('BBBB')]);
  assert.deepStrictEqual(r.images, [{ n: 3, mediaType: 'image/png', data: 'AAAA' }]);
});

test('an inbound delivery with an image block carries no images', () => {
  const [r] = promptOf([{ type: 'text', text: '[agent:from bob] see [Image #1]' }, image('AAAA')]);
  assert.strictEqual(r.kind, 'inbound');
  assert.strictEqual(r.images, undefined);
});

test('a runtime reply Clodex injects is a reply record with its verb and no sender; an agent:from delivery keeps its sender; a mid-line bracket stays a typed prompt', () => {
  const rows = [
    ['[agent:reboot] reboot queued — restarting once idle', { id: 'u', kind: 'reply', ts: null, turn: 1, verb: 'reboot', glyph: '↻', label: 'reboot', text: 'reboot queued — restarting once idle' }],
    ['[agent:task] ticket t1 created', { id: 'u', kind: 'reply', ts: null, turn: 1, verb: 'task', glyph: '⇄', label: 'task', ticket: { id: 't1', tag: null }, text: 'ticket t1 created' }],
    ['[agent:branch] main', { id: 'u', kind: 'reply', ts: null, turn: 1, verb: 'branch', glyph: '◇', label: 'branch', text: 'main' }],
    ['[agent:task done t1] report', { id: 'u', kind: 'prompt', ts: null, turn: 1, text: '[agent:task done t1] report', source: 'typed' }],
    ['[agent:from wirescope] hi', { id: 'u', kind: 'inbound', ts: null, turn: 1, from: 'wirescope', text: 'hi' }],
    ['I ran [agent:who] earlier', { id: 'u', kind: 'prompt', ts: null, turn: 1, text: 'I ran [agent:who] earlier', source: 'typed' }],
    ['a lone <pasted_content id="x"> never closed', { id: 'u', kind: 'prompt', ts: null, turn: 1, text: 'a lone <pasted_content id="x"> never closed', source: 'typed' }],
  ];
  for (const [text, want] of rows) {
    const { records } = recordsOf(rec({ type: 'user', uuid: 'u', message: { content: text } }));
    assert.deepStrictEqual(records, [want], text);
  }
});

const prompt = (i) => rec({ type: 'user', uuid: `p${i}`, message: { content: `m${i}` } });
const reply = (i, k) => rec({ type: 'assistant', uuid: `a${i}-${k}`, message: { content: [{ type: 'text', text: `r${i}-${k}` }] } });

test(`the ${RECORD_CAP}-record cap is cut on a turn boundary, so the first record shown heads its turn`, () => {
  const lines = [];
  for (let i = 0; i < 3; i += 1) {
    lines.push(prompt(i));
    for (let k = 0; k < 3; k += 1) lines.push(reply(i, k));
  }
  const { records } = recordsOf(lines.join('\n'), 6);
  assert.deepStrictEqual(records.map((r) => r.id), ['p2', 'a2-0', 'a2-1', 'a2-2']);
  assert.strictEqual(recordsOf(lines.join('\n'), 8).records[0].id, 'p1');
  assert.strictEqual(recordsOf(lines.join('\n')).records.length, 12);
});

test('a single turn longer than the cap keeps its head record ahead of the newest records', () => {
  const lines = [prompt(0)];
  for (let k = 0; k < 6; k += 1) lines.push(reply(0, k));
  const { records } = recordsOf(lines.join('\n'), 3);
  assert.deepStrictEqual(records.map((r) => r.id), ['p0', 'a0-4', 'a0-5']);
});

const said = (text) => rec({ type: 'assistant', uuid: 'a', message: { content: [{ type: 'text', text }] } });
const FILED = '/Users/x/.clodex/spill/clodex/2c45916d63a7c913.md';

test('an all-prose assistant record keeps its exact shape: no segments key', () => {
  const { records } = recordsOf(said('just prose\n\\[agent:who] escaped\n```\n[agent:who]\n```'));
  assert.deepStrictEqual(records, [{ id: 'a', kind: 'assistant', ts: null, turn: 0, text: 'just prose\n\\[agent:who] escaped\n```\n[agent:who]\n```' }]);
});

test('segmentsOf: prose, a stack of intents with their heads, an inert line, and the operator tail', () => {
  const text = [
    'Both converge.',
    '',
    '[agent:dm bob urgent] hi',
    'second line',
    '[agent:end]',
    '',
    '[agent:task add hand start] Fix it',
    '[agent:end]',
    '[agent:task bogus]',
    '[agent:who]',
    'tail prose',
  ].join('\n');
  assert.deepStrictEqual(segmentsOf(text), [
    { kind: 'prose', text: 'Both converge.' },
    { kind: 'intent', verb: 'dm', sub: null, fields: { target: 'bob', urgent: true }, body: 'hi\nsecond line', state: 'fire', spill: null, open: false,
      head: { glyph: '→', label: 'message', target: 'bob', chips: ['urgent'] } },
    { kind: 'intent', verb: 'task', sub: 'add', fields: { who: 'hand', id: null, park: false, start: true, dup: false, reviewer: null }, body: 'Fix it', state: 'fire', spill: null, open: false,
      head: { glyph: '⊕', label: 'dispatch', target: 'hand', chips: ['start'] } },
    { kind: 'inert', text: '[agent:task bogus]' },
    { kind: 'intent', verb: 'who', sub: null, fields: {}, body: null, state: 'fire', spill: null, open: false,
      head: { glyph: '◎', label: 'who', target: null, chips: [] } },
    { kind: 'prose', text: 'tail prose' },
  ]);
});

test('segmentsOf: an unclosed greedy body is open', () => {
  const segs = segmentsOf('[agent:shout] still writing\nmore');
  assert.deepStrictEqual(segs.map((s) => [s.kind, s.body, s.open]), [['intent', 'still writing\nmore', true]]);
});

test('segmentsOf: a filed stand-in becomes a filed card whose head is parsed from the stand-in line', () => {
  const segs = segmentsOf(`[agent:dm clodex] Design saved — 6.2 KB filed at ${FILED}\n[agent:end]`);
  assert.deepStrictEqual(segs, [{ kind: 'intent', verb: 'dm', sub: null, fields: { target: 'clodex', urgent: false }, body: null, state: 'filed',
    spill: { path: FILED, bytes: 6349, title: 'Design saved' }, open: false, head: { glyph: '→', label: 'message', target: 'clodex', chips: [] } }]);
});

test('segmentsOf: a bare filed pointer is prose carrying its spill; a receipt is a filed card', () => {
  const receipt = `(I sent task add hand start in full, 5300 B; Clodex kept my text at ${FILED}.)`;
  const segs = segmentsOf(`800 B of prose filed at ${FILED}\n${receipt}`);
  assert.deepStrictEqual(segs, [
    { kind: 'prose', text: `800 B of prose filed at ${FILED}`, spill: { path: FILED, bytes: 800, title: null } },
    { kind: 'intent', verb: 'task', sub: 'add', fields: {}, body: null, state: 'filed', spill: { path: FILED, bytes: null, title: null }, open: false,
      head: { glyph: '⊕', label: 'dispatch', target: 'hand', chips: ['start'] } },
  ]);
});

test('segmentsOf: an exec JSON body stops at the closing brace, and prose after it is its own segment', () => {
  const segs = segmentsOf('[agent:exec clodex-team] {"a":\n1}\nafter');
  assert.deepStrictEqual(segs.map((s) => [s.kind, s.body || s.text]), [['intent', '{"a":\n1}'], ['prose', 'after']]);
});

test(`segment strings share one ${PROSE_CAP}-character budget and the record says truncated`, () => {
  const big = 'y'.repeat(PROSE_CAP - 10);
  const { records } = recordsOf(said(`${big}\n[agent:shout] ${'z'.repeat(50)}`));
  const [r] = records;
  assert.strictEqual(r.truncated, true);
  assert.strictEqual(r.segments[0].text.length + r.segments[1].body.length, PROSE_CAP);
});

const CWD = '/Users/op/projects/wb-wrap-ui';
const bashAt = (command, cwd = CWD) => {
  const { records } = recordsOf(rec({ type: 'assistant', uuid: 'u', cwd, message: { content: [{ type: 'tool_use', id: 'b', name: 'Bash', input: { command } }] } }));
  return [records[0].arg, records[0].argShown];
};

const CD_ROWS = [
  ['cd /Users/op/projects/wb-wrap-ui; git status', 'git status'],
  ['cd /Users/op/projects/wb-wrap-ui && git status', 'git status'],
  ['cd /Users/op/projects/wb-wrap-ui-t1158-fold-rows; npm test', 'npm test'],
  ['cd "/Users/op/projects/wb-wrap-ui-t1158-fold-rows" && npm test', 'npm test'],
  ['cd /Users/op/projects/other && git status', undefined],
  ['cd /Users/op/projects/wb-wrap-ui-old; git status', undefined],
  ['cd /Users/op/projects/wb-wrap-ui-t1158/sub; git status', undefined],
  ['cd /Users/op/projects/wb-wrap-ui', undefined],
  ['git status', undefined],
];

for (const [command, shown] of CD_ROWS) {
  test(`Bash display arg of ${JSON.stringify(command)} is ${JSON.stringify(shown)}, and arg stays raw`, () => {
    assert.deepStrictEqual(bashAt(command), [command, shown]);
  });
}

test('a Bash cd prefix is kept when the record carries no cwd', () => {
  assert.deepStrictEqual(bashAt('cd /Users/op/projects/wb-wrap-ui; git status', null), ['cd /Users/op/projects/wb-wrap-ui; git status', undefined]);
});

test('a Bash description rides the record as desc; other tools carry neither desc nor argShown', () => {
  const { records } = recordsOf(rec({ type: 'assistant', uuid: 'u', cwd: CWD, message: { content: [
    { type: 'tool_use', id: 'b', name: 'Bash', input: { command: 'ls', description: 'List files' } },
    { type: 'tool_use', id: 'r', name: 'Read', input: { file_path: `${CWD}/a.js`, description: 'x' } },
  ] } }));
  assert.deepStrictEqual(records.map((r) => [r.name, r.desc, r.argShown]), [['Bash', 'List files', undefined], ['Read', undefined, undefined]]);
});

test('isInternalRow is true for what Clodex injects and false for the operator and the agent', () => {
  const rows = [
    [{ kind: 'inbound', from: 'user', text: 'x' }, false],
    [{ kind: 'inbound', from: 'ticket-loop', text: 'x' }, true],
    [{ kind: 'inbound', from: 'nits-coords', via: 'subagent', text: 'x' }, true],
    [{ kind: 'inbound', from: 'reminder', text: 'x' }, true],
    [{ kind: 'inbound', from: 'clodex-hand-12', text: 'x' }, true],
    [{ kind: 'reply', verb: 'task', text: 'x' }, true],
    [{ kind: 'notice', level: 'info', text: 'x' }, true],
    [{ kind: 'notification', text: 'x' }, true],
    [{ kind: 'prompt', text: 'x' }, false],
    [{ kind: 'assistant', text: 'x' }, false],
    [{ kind: 'assistant', text: 'API Error', apiError: true }, false],
    [{ kind: 'tool', name: 'Bash' }, false],
    [{ kind: 'command', name: '/context' }, false],
    [{ kind: 'command-output', text: 'x' }, false],
    [{ kind: 'boundary', what: 'compact' }, false],
    [null, false],
  ];
  assert.deepStrictEqual(rows.map(([r]) => isInternalRow(r)), rows.map(([, want]) => want));
});

test('ticketOf reads the bracket marker on inbound text and the bare ticket id on a task reply', () => {
  const rows = [
    ['[ticket t5]', 'inbound', { id: 't5', tag: null }],
    ['[ticket t5 MERGED] landed on master', 'inbound', { id: 't5', tag: 'MERGED' }],
    ['[ticket t5 REVIEW REDELIVERY] again', 'inbound', { id: 't5', tag: 'REVIEW REDELIVERY' }],
    ['[ticket t5 merged 3h ago, not accepted]', 'inbound', { id: 't5', tag: 'merged 3h ago, not accepted' }],
    ['[ticket t5 merged, not accepted]', 'inbound', { id: 't5', tag: 'merged, not accepted' }],
    ['[tickets t5]', 'inbound', null],
    ['see [ticket t5 MERGED]', 'inbound', null],
    ['ticket t5 created and started', 'inbound', null],
    ['ticket t5 created and started', 'reply', { id: 't5', tag: null }],
    ['error: ticket t5 not found', 'reply', null],
    ['tickets t5', 'reply', null],
  ];
  for (const [text, form, want] of rows) assert.deepStrictEqual(ticketOf(text, form), want, `${form}: ${text}`);
});

test('an inbound record carries the ticket marker read after its sender prefix; a task reply carries the id; other replies and markerless inbounds carry none', () => {
  const one = (text) => recordsOf(rec({ type: 'user', uuid: 'u', message: { content: text } })).records[0];
  assert.deepStrictEqual(one('[agent:from ticket-loop] [ticket t3 ACCEPT] review round 1, no must-fixes.').ticket, { id: 't3', tag: 'ACCEPT' });
  assert.deepStrictEqual(one('[agent:from ticket-watchdog] [ticket t3] stalled: quiet').ticket, { id: 't3', tag: null });
  assert.deepStrictEqual(one('[agent:from team-hand] [ticket t3 done] Message (900 bytes) attached: @/tmp/m.txt ').ticket, { id: 't3', tag: 'done' });
  assert.deepStrictEqual(one('[agent:task] ticket t3 accepted').ticket, { id: 't3', tag: null });
  assert.strictEqual(one('[agent:task] error: no such ticket').ticket, undefined);
  assert.strictEqual(one('[agent:dm] ticket t3 delivered').ticket, undefined);
  assert.strictEqual(one('[agent:from reminder] continue t3').ticket, undefined);
});

test('the cap clip drops the whole head turn when a later turn opens inside the window', () => {
  const lines = [
    rec({ type: 'user', uuid: 'p', message: { content: 'go' } }),
    rec({ type: 'assistant', uuid: 'a', message: { content: [{ type: 'text', text: 'on it' }] } }),
    rec({ type: 'user', uuid: 'r', message: { content: '[agent:task] ticket t1 created' } }),
    rec({ type: 'assistant', uuid: 'b', message: { content: [{ type: 'text', text: 'filed' }] } }),
  ];
  assert.deepStrictEqual(recordsOf(lines.join('\n'), 2).records.map((r) => r.id), ['r', 'b']);
});

test('id-less append stability: appending two lines leaves the first run head at its literal line:N id', () => {
  const T = [
    rec({ type: 'user', message: { content: 'hi' } }),
    rec({ type: 'assistant', message: { content: [{ type: 'text', text: 'yo' }, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }] } }),
  ].join('\n');
  const before = recordsOf(T).records;
  assert.deepStrictEqual([before[0].id, before[0].kind], ['line:0', 'prompt']);
  const after = recordsOf(`${T}\n${rec({ type: 'user', message: { content: 'again' } })}\n${rec({ type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } })}`).records;
  assert.strictEqual(after.length, before.length + 2, 'ENTER: the append parsed');
  assert.deepStrictEqual(after.slice(0, before.length).map((r) => r.id), ['line:0', 'line:1', 't1']);
});

const WRAPPER = '<system-reminder>\nThe user sent a new message while you were working:\nhi\n</system-reminder>';
const midTurn = (uuid, prompt, rendered = WRAPPER) => rec({ type: 'attachment', uuid, timestamp: '2026-09-27T10:42:00.000Z', attachment: { type: 'queued_command', origin: { kind: 'human' }, commandMode: 'prompt', humanTurn: true, prompt }, rendered });
const replied = (uuid, text) => rec({ type: 'assistant', uuid, message: { content: [{ type: 'text', text }] } });
const TS = Date.parse('2026-09-27T10:42:00.000Z');

test('ENTER: the mid-turn fixture carries the CLI wrapper in rendered', () => {
  assert.ok(JSON.parse(midTurn('q', 'hi')).rendered.includes('The user sent a new message'));
});

test('a human queued_command attachment is one mid-turn prompt in the running turn, delivered, and the wrapper shows nowhere', () => {
  const { records } = recordsOf([typed('p1', 'P', 'go'), midTurn('q', 'hi')].join('\n'));
  assert.deepStrictEqual(records[1], { id: 'q', kind: 'prompt', ts: TS, turn: 1, text: 'hi', source: 'mid-turn', state: 'delivered' });
  assert.ok(!JSON.stringify(records).includes('The user sent a new message'));
});

test('an assistant record after a mid-turn prompt in the same turn marks it read and shares its turn', () => {
  const { records } = recordsOf([typed('p1', 'P', 'go'), midTurn('q', 'hi'), replied('a1', 'ok')].join('\n'));
  const mid = records.find((r) => r.id === 'q');
  const reply = records.find((r) => r.id === 'a1');
  assert.strictEqual(mid.state, 'read');
  assert.strictEqual(reply.turn, mid.turn);
});

test('only a tool_result after a mid-turn prompt leaves it delivered', () => {
  const { records } = recordsOf([
    typed('p1', 'P', 'go'),
    rec({ type: 'assistant', uuid: 'a0', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }] } }),
    midTurn('q', 'hi'),
    rec({ type: 'user', uuid: 'r1', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'x' }] } }),
  ].join('\n'));
  assert.strictEqual(records.find((r) => r.id === 'q').state, 'delivered');
});

test('a mid-turn prompt with a text block and an image block carries images like a typed prompt', () => {
  const { records } = recordsOf(midTurn('q', [{ type: 'text', text: '[Image #1]see' }, image('iVBORw0KGgo=')], null));
  assert.deepStrictEqual(records[0].images, [{ n: 1, mediaType: 'image/png', data: 'iVBORw0KGgo=' }]);
  assert.strictEqual(records[0].source, 'mid-turn');
});

test('a mid-turn prompt joins the running turn: prompt, mid-turn, assistant, prompt are turns 1, 1, 1, 2', () => {
  const { records } = recordsOf([typed('p1', 'P', 'go'), midTurn('q', 'hi'), replied('a1', 'ok'), typed('p2', 'Q', 'next')].join('\n'));
  assert.deepStrictEqual(records.map((r) => r.turn), [1, 1, 1, 2]);
});

test('a human mid-turn [agent:task] attachment is one mid-turn reply card in the running turn', () => {
  const { records } = recordsOf([typed('p1', 'P', 'go'), midTurn('q', '[agent:task] ticket t9 created')].join('\n'));
  assert.deepStrictEqual(records[1], { id: 'q', kind: 'reply', ts: TS, turn: 1, verb: 'task', glyph: '⇄', label: 'task', ticket: { id: 't9', tag: null }, text: 'ticket t9 created', source: 'mid-turn' });
  assert.strictEqual(records.length, 2);
});

test('a human mid-turn [agent:from] attachment is one mid-turn inbound card in the running turn', () => {
  const { records } = recordsOf([typed('p1', 'P', 'go'), midTurn('q', '[agent:from ticket-loop] [ticket t9 MERGED] x')].join('\n'));
  assert.strictEqual(records.length, 2);
  assert.strictEqual(records[1].kind, 'inbound');
  assert.deepStrictEqual(records[1].ticket, { id: 't9', tag: 'MERGED' });
  assert.strictEqual(records[1].source, 'mid-turn');
  assert.strictEqual(records[1].turn, 1);
});

test('a mid-turn reply card joins the running turn: prompt, mid-turn reply, assistant, prompt are turns 1, 1, 1, 2', () => {
  const { records } = recordsOf([typed('p1', 'P', 'go'), midTurn('q', '[agent:task] ticket t9 created'), replied('a1', 'ok'), typed('p2', 'Q', 'next')].join('\n'));
  assert.deepStrictEqual(records.map((r) => [r.kind, r.turn]), [['prompt', 1], ['reply', 1], ['assistant', 1], ['prompt', 2]]);
});

test('a new typed turn clears the unread list: a mid-turn prompt from the previous turn stays delivered', () => {
  const { records } = recordsOf([typed('p1', 'P', 'go'), midTurn('q', 'hi'), typed('p2', 'Q', 'next'), replied('a2', 'ok')].join('\n'));
  const q = records.find((r) => r.id === 'q');
  assert.strictEqual(q.state, 'delivered');
  assert.strictEqual(records.find((r) => r.id === 'p2').turn, q.turn + 1);
});

test('a <command-name> echo sharing a mid-turn /compact prompt\'s promptId does not pop it or take back a turn', () => {
  const mid = JSON.stringify({ ...JSON.parse(midTurn('q', '/compact')), promptId: 'P' });
  const { records } = recordsOf([
    typed('p1', 'P', 'go'),
    mid,
    typed('p2', 'P', '<command-name>/compact</command-name>\n<command-message>compact</command-message>\n<command-args></command-args>'),
    replied('a1', 'ok'),
  ].join('\n'));
  assert.deepStrictEqual(records.map((r) => [r.id, r.turn]), [['p1', 1], ['q', 1], ['a1', 1]]);
});

test('an apiError assistant record after a mid-turn prompt leaves it delivered', () => {
  const apiErr = rec({ type: 'assistant', uuid: 'e1', isApiErrorMessage: true, message: { content: [{ type: 'text', text: 'API Error: 500' }] } });
  const { records } = recordsOf([typed('p1', 'P', 'go'), midTurn('q', 'hi'), apiErr].join('\n'));
  assert.strictEqual(records.find((r) => r.id === 'e1').apiError, true, 'ENTER: the fixture parses as an apiError assistant');
  assert.strictEqual(records.find((r) => r.id === 'q').state, 'delivered');
});

test('ENTER: the same sequence with a plain assistant record marks the mid-turn prompt read', () => {
  const { records } = recordsOf([typed('p1', 'P', 'go'), midTurn('q', 'hi'), replied('e1', 'API Error: 500')].join('\n'));
  assert.strictEqual(records.find((r) => r.id === 'q').state, 'read');
});

test('a mid-turn [agent:task] attachment stays a reply card with no state and an assistant after it is not blocked', () => {
  const { records } = recordsOf([typed('p1', 'P', 'go'), midTurn('q', '[agent:task] ticket t9 created'), replied('a1', 'ok')].join('\n'));
  assert.deepStrictEqual(records[1], { id: 'q', kind: 'reply', ts: TS, turn: 1, verb: 'task', glyph: '⇄', label: 'task', ticket: { id: 't9', tag: null }, text: 'ticket t9 created', source: 'mid-turn' });
  assert.deepStrictEqual([records[2].kind, records[2].turn], ['assistant', 1], 'ENTER: the assistant record parsed in the same turn');
});

const QTS = '2026-09-27T10:43:00.000Z';
const queueOp = (operation, content, reason) => rec({ type: 'queue-operation', operation, timestamp: QTS, sessionId: 'S', ...(content === undefined ? {} : { content }), ...(reason ? { reason } : {}) });
const queuedOf = (records) => records.filter((r) => r.state === 'queued');

test('an enqueued message is a queued mid-turn prompt at the end of the running turn', () => {
  const { records } = recordsOf([typed('p1', 'P', 'go'), queueOp('enqueue', 'hi')].join('\n'));
  assert.strictEqual(records[0].id, 'p1');
  assert.deepStrictEqual(records.slice(1), [{ id: `queued:${Date.parse(QTS)}:0`, kind: 'prompt', ts: Date.parse(QTS), turn: 1, text: 'hi', source: 'mid-turn', state: 'queued' }]);
});

test('a queued message absorbed mid-turn leaves one row, the delivered one from the attachment', () => {
  const { records } = recordsOf([typed('p1', 'P', 'go'), queueOp('enqueue', 'hi'), queueOp('remove', 'hi', 'absorbed_mid_turn'), midTurn('q', 'hi')].join('\n'));
  assert.deepStrictEqual(records.filter((r) => r.text === 'hi').map((r) => [r.id, r.state]), [['q', 'delivered']]);
  assert.deepStrictEqual(queuedOf(records), []);
});

test('a dequeued message is no longer queued, and the prompt it opens is turn 2', () => {
  const upToDequeue = recordsOf([typed('p1', 'P', 'go'), queueOp('enqueue', 'hi'), queueOp('dequeue')].join('\n')).records;
  assert.deepStrictEqual(queuedOf(upToDequeue), []);
  const { records } = recordsOf([typed('p1', 'P', 'go'), queueOp('enqueue', 'hi'), queueOp('dequeue'), typed('p2', 'Q', 'hi')].join('\n'));
  assert.deepStrictEqual(queuedOf(records), []);
  assert.strictEqual(records.find((r) => r.id === 'p2').turn, 2);
});

test('remove drops the entry whose text matches, not merely the oldest', () => {
  const a = recordsOf([typed('p1', 'P', 'go'), queueOp('enqueue', 'a'), queueOp('enqueue', 'b'), queueOp('remove', 'a')].join('\n')).records;
  assert.deepStrictEqual(queuedOf(a).map((r) => r.text), ['b']);
  const b = recordsOf([typed('p1', 'P', 'go'), queueOp('enqueue', 'a'), queueOp('enqueue', 'b'), queueOp('remove', 'b')].join('\n')).records;
  assert.deepStrictEqual(queuedOf(b).map((r) => r.text), ['a']);
});

test('an assistant record does not consume a queued message', () => {
  const { records } = recordsOf([typed('p1', 'P', 'go'), queueOp('enqueue', 'hi'), replied('a1', 'ok')].join('\n'));
  assert.deepStrictEqual(queuedOf(records).map((r) => [r.text, r.turn]), [['hi', 1]]);
  assert.strictEqual(records[records.length - 1].state, 'queued');
});

test('a typed prompt clears the queue and the queue operations never advance the turn', () => {
  const { records } = recordsOf([typed('p1', 'P', 'go'), queueOp('enqueue', 'x'), typed('p2', 'Q', 'next')].join('\n'));
  assert.deepStrictEqual(records.map((r) => [r.id, r.turn]), [['p1', 1], ['p2', 2]]);
});

test('a queued task-notification is no queued record', () => {
  const { records } = recordsOf([typed('p1', 'P', 'go'), queueOp('enqueue', '<task-notification>x</task-notification>')].join('\n'));
  assert.deepStrictEqual(records.map((r) => r.id), ['p1']);
});

test('a queued peer message is no queued prompt', () => {
  const { records } = recordsOf([typed('p1', 'P', 'go'), queueOp('enqueue', '[agent:from lead] hi')].join('\n'));
  assert.deepStrictEqual(records.map((r) => r.id), ['p1']);
});

test('the queue keeps non-prompt entries so their remove matches them, not the operator message', () => {
  const N = '<task-notification>x</task-notification>';
  const { records } = recordsOf([typed('p1', 'P', 'go'), queueOp('enqueue', N), queueOp('enqueue', 'hi'), queueOp('remove', N)].join('\n'));
  assert.deepStrictEqual(queuedOf(records).map((r) => r.text), ['hi']);
});

test('popAll pulls every queued message back to the editor', () => {
  const { records } = recordsOf([typed('p1', 'P', 'go'), queueOp('enqueue', 'hi'), queueOp('popAll', 'hi')].join('\n'));
  assert.deepStrictEqual(queuedOf(records), []);
});

test('two queued messages with the same timestamp keep distinct ids', () => {
  const { records } = recordsOf([typed('p1', 'P', 'go'), queueOp('enqueue', 'a'), queueOp('enqueue', 'b')].join('\n'));
  assert.deepStrictEqual(queuedOf(records).map((r) => [r.id, r.text]), [[`queued:${Date.parse(QTS)}:0`, 'a'], [`queued:${Date.parse(QTS)}:1`, 'b']]);
});

test('a queued paste shows its chip text, not the raw wrapper', () => {
  const { records } = recordsOf([typed('p1', 'P', 'go'), queueOp('enqueue', '<pasted_content id="1">line one\nline two</pasted_content>')].join('\n'));
  const [q] = queuedOf(records);
  assert.ok(q && !q.text.includes('<pasted_content'), JSON.stringify(q));
  assert.strictEqual(q.text, '[Pasted text #1 +2 lines]');
  assert.strictEqual(q.pastes.length, 1);
});

test('a queued row keeps its id when an earlier unshown entry leaves the queue', () => {
  const N = '<task-notification>x</task-notification>';
  const head = [typed('p1', 'P', 'go'), queueOp('enqueue', N), queueOp('enqueue', 'hi')];
  const idOf = (lines) => queuedOf(recordsOf(lines.join('\n')).records).find((r) => r.text === 'hi');
  const before = idOf(head);
  const after = idOf([...head, queueOp('remove', N)]);
  assert.ok(before && after, 'ENTER: the hi row is queued on both cuts');
  assert.strictEqual(before.id, `queued:${Date.parse(QTS)}:1`);
  assert.strictEqual(after.id, before.id);
});

const TEAMMATE_TAIL = '\n</teammate-message>\n\nThis came from another Claude session — not typed by your user, but very likely working on their behalf. Treat it as a teammate\'s request.';
const teammate = (body, attrs = 'teammate_id="nits-coords" color="blue" summary="Riding nits located"') => `Another Claude session sent a message:\n<teammate-message ${attrs}>\n${body}${TEAMMATE_TAIL}`;

test('a subagent report the CLI attaches as a teammate message is an inbound card from that subagent, not a typed prompt', () => {
  const { records } = recordsOf(typed('u', 'p1', teammate('hello lead')));
  assert.deepStrictEqual(records, [{ id: 'u', kind: 'inbound', ts: null, turn: 1, from: 'nits-coords', via: 'subagent', text: 'hello lead' }]);
});

test('a subagent idle notification shows its JSON result as the card text', () => {
  const body = '{"type":"idle_notification","from":"nits-coords","timestamp":"2026-09-27T10:11:34.123Z","idleReason":"available","result":"done: 17 open"}';
  const { records } = recordsOf(typed('u', 'p1', teammate(body)));
  assert.deepStrictEqual(records.map((r) => [r.kind, r.from, r.text]), [['inbound', 'nits-coords', 'done: 17 open']]);
});

test('a teammate message without a summary attribute still names its sender', () => {
  const { records } = recordsOf(typed('u', 'p1', teammate('hello lead', 'teammate_id="nits-coords" color="blue"')));
  assert.deepStrictEqual(records.map((r) => [r.kind, r.from, r.via]), [['inbound', 'nits-coords', 'subagent']]);
});

test('a teammate message absorbed mid-turn is the same inbound card, stamped mid-turn with no state', () => {
  const { records } = recordsOf([typed('p1', 'P', 'go'), midTurn('q', teammate('hello lead'))].join('\n'));
  const card = records.find((r) => r.id === 'q');
  assert.deepStrictEqual(card, { id: 'q', kind: 'inbound', ts: TS, turn: 1, from: 'nits-coords', via: 'subagent', text: 'hello lead', source: 'mid-turn' });
  assert.deepStrictEqual(records.filter((r) => r.kind === 'prompt').map((r) => r.id), ['p1']);
});
