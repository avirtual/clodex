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
