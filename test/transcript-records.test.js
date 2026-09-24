'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { RECORD_CAP, PROMPT_CAP, recordsOf } = require('../transcript-records');

const FIXTURES = path.join(__dirname, 'fixtures', 'transcript-records');
const fixture = (name) => fs.readFileSync(path.join(FIXTURES, `${name}.jsonl`), 'utf8');
const rec = (o) => JSON.stringify(o);

const BASH_PLAIN = { interrupted: false, background: false, persisted: null };

const ROWS = [
  ['a Bash success with one short output line carries it as only', 'bash-ok', [{
    id: 'toolu_01Adbs7yzWMhKVXywkHPLaJJ', kind: 'tool', ts: 1789988805620, turn: 0, name: 'Bash', arg: 'wc -l docs/DESIGN.md', state: 'ok',
    sum: { exit: 0, lines: 1, ...BASH_PLAIN, only: '210 docs/DESIGN.md' },
  }]],
  ['a Bash Exit code 1 with a string toolUseResult parses the exit and counts the lines after it', 'bash-exit', [{
    id: 'toolu_01G7QbzNV7SDUYafrQeJaQhC', kind: 'tool', ts: 1790229197666, turn: 0, name: 'Bash', arg: 'ls docs/tasks | tail -3; grep -rl t1129 docs/tasks | head -1', state: 'error',
    sum: { exit: 1, lines: 3, ...BASH_PLAIN, only: null },
  }]],
  ['a <tool_use_error> block is an error whose message is its first line, tag stripped', 'tool-use-error', [{
    id: 'toolu_01W1VArV7gi4UjNMb4TBVDA3', kind: 'tool', ts: 1790196151640, turn: 0, name: 'Bash',
    arg: 'sleep 240; tail -1 /repo/tmp/publish-image-5.86.0.log | cut -c1-120; pgrep -f publish-image.sh >/dev/null && echo "publish running" || (echo "publish finished";',
    state: 'error',
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

test('meta, sidechain, attachment, bookkeeping and orphan tool_result records produce nothing', () => {
  const { records } = recordsOf([
    rec({ type: 'user', uuid: 'm', isMeta: true, message: { content: 'meta' } }),
    rec({ type: 'user', uuid: 's', isSidechain: true, message: { content: 'sub' } }),
    rec({ type: 'attachment', uuid: 'a', attachment: { type: 'x' } }),
    rec({ type: 'ai-title', uuid: 't', aiTitle: 'x' }),
    rec({ type: 'user', uuid: 'o', message: { content: [{ type: 'tool_result', tool_use_id: 'gone', content: 'x' }] } }),
    rec({ type: 'user', uuid: 'x', message: { content: '<local-command-caveat>x</local-command-caveat>' } }),
    'not json',
  ].join('\n'));
  assert.deepStrictEqual(records, []);
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
