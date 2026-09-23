'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { mkTmpRoot } = require('./lib/tmp-roots');
const { MAX_ENTRIES, parseTranscript, createTranscriptSpikeReader } = require('../transcript-spike');

const rec = (o) => JSON.stringify(o);
const LINES = [
  rec({ type: 'user', message: { role: 'user', content: 'run the tests' } }),
  rec({ type: 'user', isMeta: true, message: { role: 'user', content: 'meta noise' } }),
  rec({ type: 'attachment', attachment: { type: 'x' } }),
  rec({ type: 'assistant', message: { content: [
    { type: 'thinking', thinking: 'hidden' },
    { type: 'text', text: 'Running them now.' },
    { type: 'tool_use', name: 'Bash', input: { command: 'npm test\n--verbose', description: 'd' } },
  ] } }),
  rec({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }] } }),
  rec({ type: 'user', message: { role: 'user', content: '<local-command-stdout>x</local-command-stdout>' } }),
  'not json',
  rec({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/a/b.js', old_string: 'x' } }] } }),
];

test('one entry per user text, assistant text and tool_use; meta, tool results, attachments and command echoes dropped', () => {
  assert.deepStrictEqual(parseTranscript(LINES.join('\n')), [
    '❯ run the tests',
    '⏺ Running them now.',
    '  → Bash(npm test)',
    '  → Edit(/a/b.js)',
  ]);
});

test('only the last MAX_ENTRIES entries are kept', () => {
  const many = Array.from({ length: MAX_ENTRIES + 5 }, (_, i) => rec({ type: 'user', message: { content: `m${i}` } }));
  const out = parseTranscript(many.join('\n'));
  assert.strictEqual(out.length, 200);
  assert.strictEqual(out[0], '❯ m5');
});

test('pull reads through the link, re-reads only after the watcher fires, and follows a repoint', () => {
  const root = mkTmpRoot('clodex-tspike-');
  const a = path.join(root, 'a.jsonl');
  const b = path.join(root, 'b.jsonl');
  const link = path.join(root, 'transcript.jsonl');
  fs.writeFileSync(a, `${LINES[0]}\n`);
  fs.writeFileSync(b, `${rec({ type: 'user', message: { content: 'after clear' } })}\n`);
  fs.symlinkSync(a, link);
  const fires = new Map();
  const watch = (p, cb) => { fires.set(p, cb); return { close() { fires.delete(p); }, on() {} }; };
  const reader = createTranscriptSpikeReader({ linkPathFor: () => link, watch });
  const first = reader.pull('s');
  assert.deepStrictEqual([first.ok, first.rev, first.lines], [true, 1, ['❯ run the tests']]);
  fs.appendFileSync(a, `${LINES[3]}\n`);
  assert.strictEqual(reader.pull('s').rev, 1);
  fires.get(fs.realpathSync(a))();
  const second = reader.pull('s');
  assert.strictEqual(second.rev, 2);
  assert.strictEqual(second.lines.length, 3);
  fs.unlinkSync(link);
  fs.symlinkSync(b, link);
  const third = reader.pull('s');
  assert.deepStrictEqual(third.lines, ['❯ after clear']);
  assert.strictEqual(fires.has(fs.realpathSync(a)), false);
  fs.unlinkSync(link);
  assert.deepStrictEqual(reader.pull('s'), { ok: false, reason: 'unavailable' });
  reader.dispose();
});
