'use strict';
// output.test.js — the human renderers + the print seam.
const { test } = require('node:test');
const assert = require('node:assert');
const O = require('../src/output');

test('table aligns columns, trims trailing space', () => {
  const t = O.table(['NAME', 'X'], [['a', '1'], ['longer', '2']]);
  const lines = t.split('\n');
  assert.strictEqual(lines[0], 'NAME    X');
  assert.strictEqual(lines[1], 'a       1');
  assert.strictEqual(lines[2], 'longer  2');
});

test('renderSessions builds a NAME/TYPE/ACTIVITY/CWD table', () => {
  const s = O.renderSessions([{ name: 'b', type: 'claude', activity: 'idle', cwd: '/w' }]);
  assert.match(s, /NAME/);
  assert.match(s, /b\s+claude\s+idle\s+\/w/);
});

test('renderTranscript role-prefixes with blank lines between turns', () => {
  const s = O.renderTranscript([{ role: 'user', text: 'hi' }, { role: 'assistant', text: 'yo' }]);
  assert.strictEqual(s, '[user] hi\n\n[assistant] yo');
});

test('makePrinter.json emits one compact line', () => {
  let buf = '';
  const p = O.makePrinter((s) => (buf += s));
  p.json({ a: 1 });
  assert.strictEqual(buf, '{"a":1}\n');
});

test('makePrinter defaults to format json, and json output is byte-for-byte unchanged by the seam', () => {
  let buf = '';
  const p = O.makePrinter((s) => (buf += s));
  assert.strictEqual(p.format, 'json');
  p.json({ a: 1, b: ['x', null] });
  p.json({ a: 2 });
  assert.strictEqual(buf, '{"a":1,"b":["x",null]}\n{"a":2}\n');
});

test('makePrinter under format yaml emits toYaml, not a json line', () => {
  let buf = '';
  const p = O.makePrinter((s) => (buf += s));
  p.format = 'yaml';
  p.json({ a: 1, b: ['x', null] });
  assert.strictEqual(buf, 'a: 1\nb:\n  - x\n  - null\n');
});

test('under yaml every streamed doc after the first is preceded by ---', () => {
  let buf = '';
  const p = O.makePrinter((s) => (buf += s));
  p.format = 'yaml';
  p.json({ seq: 1 });
  p.json({ seq: 2 });
  p.json({ seq: 3 });
  assert.strictEqual(buf, 'seq: 1\n---\nseq: 2\n---\nseq: 3\n');
});

test('stripAnsi removes SGR, cursor moves, private modes, OSC titles', () => {
  const ESC = '\x1b';
  const s = `${ESC}[32mgreen${ESC}[0m ${ESC}]0;title\x07plain${ESC}[2J${ESC}[H${ESC}[?25l done`;
  assert.strictEqual(O.stripAnsi(s), 'green plain done');
});

test('stripAnsi strips ST-terminated OSC hyperlinks, leaves plain text intact', () => {
  const ESC = '\x1b';
  const s = `pre ${ESC}]8;;http://x${ESC}\\link${ESC}]8;;${ESC}\\ post`;
  assert.strictEqual(O.stripAnsi(s), 'pre link post');
  assert.strictEqual(O.stripAnsi('no escapes at all'), 'no escapes at all');
});

test('renderTranscript --timestamps: the verbatim ISO, one space, then the role prefix', () => {
  const s = O.renderTranscript(
    [{ role: 'user', text: 'hi', ts: '2026-09-17T02:20:16.743Z' }, { role: 'assistant', text: 'yo', ts: null }],
    { timestamps: true },
  );
  assert.strictEqual(s, '2026-09-17T02:20:16.743Z [user] hi\n\n- [assistant] yo',
    'the stamp is passed through unparsed, and a null ts holds the column with a dash');
});

test('renderTranscript: the default render ignores ts entirely — byte-identical with and without one', () => {
  const withTs = O.renderTranscript([{ role: 'user', text: 'hi', ts: '2026-09-17T02:20:16.743Z' }]);
  assert.strictEqual(withTs, '[user] hi', 'a ts on the row does not leak into the default render');
  assert.strictEqual(O.renderTranscript([{ role: 'user', text: 'hi' }]), withTs);
  assert.strictEqual(
    O.renderTranscript([{ role: 'user', text: 'hi', ts: 'x' }], { timestamps: false }),
    '[user] hi', 'an explicit false is the default, not a third mode');
});
