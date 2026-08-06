'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { createMarkParser, formatCommand } = require('../term-marks');
const { stripAnsi } = require('../cli/src/output');

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const A = '\x1b]133;A\x07';
const C = (cmd) => `\x1b]133;C;${b64(cmd)}\x07`;
const D = (code) => `\x1b]133;D;${code}\x07`;

function collect() {
  const recs = [];
  return { recs, parser: createMarkParser({ onCommand: (r) => recs.push(r) }) };
}

test('a framed command yields its line, exit code and output', () => {
  const { recs, parser } = collect();
  parser.feed(`${A}${C('echo hi')}hi\n${D(0)}${A}`);
  assert.strictEqual(recs.length, 1, 'ENTER: exactly one command was framed');
  assert.deepStrictEqual(recs[0], { command: 'echo hi', exitCode: 0, output: 'hi\n' });
});

test('a nonzero exit is carried through', () => {
  const { recs, parser } = collect();
  parser.feed(`${A}${C('false')}${D(1)}${A}`);
  assert.strictEqual(recs.length, 1, 'ENTER: the failing command was framed');
  assert.strictEqual(recs[0].exitCode, 1);
});

// The command is what RAN, which may differ from what was proposed — the whole
// reason it rides the mark instead of being remembered from the write side.
test('a command containing semicolons, quotes and newlines survives base64', () => {
  const cmd = `printf 'a;b\n' && echo "x;y"`;
  const { recs, parser } = collect();
  parser.feed(`${C(cmd)}out\n${D(0)}`);
  assert.strictEqual(recs.length, 1, 'ENTER: the awkward command was framed');
  assert.strictEqual(recs[0].command, cmd);
});

test('marks split across feeds are still framed', () => {
  const { recs, parser } = collect();
  const whole = `${C('ls')}a\n${D(0)}`;
  for (let i = 0; i < whole.length; i++) parser.feed(whole[i]);
  assert.strictEqual(recs.length, 1, 'ENTER: the byte-split stream framed one command');
  assert.deepStrictEqual(recs[0], { command: 'ls', exitCode: 0, output: 'a\n' });
});

// A partial mark held across feeds must not be printed as output — that is the
// visible symptom of a naive splitter.
test('a mark split mid-sequence never leaks its bytes into output', () => {
  const { recs, parser } = collect();
  const whole = `${C('ls')}a\n${D(0)}`;
  for (let i = 0; i < whole.length; i++) parser.feed(whole[i]);
  assert.strictEqual(recs.length, 1, 'ENTER: one command framed');
  assert.ok(!/\x1b|133/.test(recs[0].output), 'no mark bytes in the captured output');
});

test('output before the first command is not captured', () => {
  const { recs, parser } = collect();
  parser.feed(`motd banner\n${A}${C('x')}real\n${D(0)}`);
  assert.strictEqual(recs.length, 1, 'ENTER: one command framed');
  assert.strictEqual(recs[0].output, 'real\n');
});

// Ctrl-C at the prompt: zsh redraws without ever running anything.
test('a command abandoned at the prompt is dropped, not reported', () => {
  const { recs, parser } = collect();
  parser.feed(`${A}${C('rm -rf /')}${A}`);
  assert.strictEqual(recs.length, 0, 'nothing ran, so nothing is reported');
});

test('an abandoned command does not steal the next command output', () => {
  const { recs, parser } = collect();
  parser.feed(`${A}${C('abandoned')}${A}${C('real')}mine\n${D(0)}`);
  assert.strictEqual(recs.length, 1, 'ENTER: only the command that ran was framed');
  assert.deepStrictEqual(recs[0], { command: 'real', exitCode: 0, output: 'mine\n' });
});

// The case that makes the abandon-drop load-bearing, and the one a naive corpus
// misses: the NEXT C resets everything anyway, so an abandoned command only
// becomes visible when no C follows. Pressing Enter on an empty line is exactly
// that — zsh redraws the prompt (D) without firing preexec, so a parser that
// held the abandoned line open reports a command that was never run, with
// whatever printed since attributed to it.
test('an abandoned command is not resurrected by a later bare prompt', () => {
  const { recs, parser } = collect();
  parser.feed(`${A}${C('rm -rf /')}`);   // typed, then interrupted
  parser.feed(A);                        // Ctrl-C: prompt redrawn, nothing ran
  parser.feed('unrelated banner\n');
  parser.feed(`${D(0)}${A}`);            // Enter on an empty line
  assert.strictEqual(recs.length, 0, 'a command that never ran is never reported');
});

// precmd fires before anything has been typed, so the first prompt emits a bare
// D. Reporting it would invent a command.
test('a D with no preceding C reports nothing', () => {
  const { recs, parser } = collect();
  parser.feed(`${D(0)}${A}`);
  assert.strictEqual(recs.length, 0, 'a bare prompt is not a command');
});

test('several commands in one chunk are framed separately', () => {
  const { recs, parser } = collect();
  parser.feed(`${C('one')}1\n${D(0)}${A}${C('two')}2\n${D(3)}${A}`);
  assert.strictEqual(recs.length, 2, 'ENTER: both commands were framed');
  assert.deepStrictEqual(recs.map((r) => [r.command, r.exitCode, r.output]),
    [['one', 0, '1\n'], ['two', 3, '2\n']]);
});

test('a non-numeric exit status becomes null rather than NaN', () => {
  const { recs, parser } = collect();
  parser.feed(`${C('x')}${'\x1b]133;D;oops\x07'}`);
  assert.strictEqual(recs.length, 1, 'ENTER: the command was framed');
  assert.strictEqual(recs[0].exitCode, null);
});

test('output is capped at the TAIL, where the error is', () => {
  const { recs, parser } = collect();
  const p = createMarkParser({ onCommand: (r) => recs.push(r), maxOutput: 100 });
  p.feed(`${C('big')}${'x'.repeat(500)}TAIL${D(1)}`);
  assert.strictEqual(recs.length, 1, 'ENTER: the big command was framed');
  assert.ok(recs[0].output.length <= 100, 'capped');
  assert.ok(recs[0].output.endsWith('TAIL'), 'the tail survived, not the head');
});

test('a lone ESC at the end of a chunk does not grow the carry unboundedly', () => {
  const { parser } = collect();
  for (let i = 0; i < 5000; i++) parser.feed('\x1b');
  assert.ok(parser._state().carry <= 8 * 1024, 'carry stays bounded');
});

// --- formatCommand -------------------------------------------------------

test('a successful command reports its line alone, not its output', () => {
  const out = formatCommand({ command: 'npm test', exitCode: 0, output: 'x\n'.repeat(4000) });
  assert.strictEqual(out, '[terminal] npm test\nexit 0');
});

test('a failing command carries its output', () => {
  const out = formatCommand({ command: 'npm test', exitCode: 1, output: 'boom\n' });
  assert.match(out, /exit 1/);
  assert.match(out, /boom/);
});

test('a truncated tail SAYS it was truncated', () => {
  const lines = Array.from({ length: 200 }, (_, i) => `line${i}`).join('\n');
  const out = formatCommand({ command: 'x', exitCode: 1, output: lines }, { maxLines: 10 });
  assert.match(out, /last 10 of 200 lines/, 'the truncation is stated, not silent');
  assert.match(out, /line199/, 'the tail is what survived');
  assert.ok(!/line0\b/.test(out), 'the head is gone');
});

test("zsh's partial-line marker is stripped from the tail", () => {
  const E = '\x1b';
  const output = `real error\n${E}[1m${E}[7m%${E}[27m${E}[0m     \n`;
  const out = formatCommand({ command: 'x', exitCode: 1, output }, { stripAnsi });
  assert.match(out, /real error/);
  assert.ok(!/%/.test(out), 'the display artifact is not reported as output');
});

test('a legitimate percent in the last line is kept', () => {
  const out = formatCommand({ command: 'x', exitCode: 1, output: 'cpu 40%\n' }, { stripAnsi });
  assert.match(out, /cpu 40%/, 'only a BARE marker line is dropped');
});

test('a command with no text is not reported', () => {
  assert.strictEqual(formatCommand({ command: '   ', exitCode: 0, output: 'x' }), null);
});

test('an unknown exit code is stated as unknown, not as success', () => {
  const out = formatCommand({ command: 'x', exitCode: null, output: '' });
  assert.match(out, /exit unknown/);
});

test('always:true carries output for a successful command', () => {
  const out = formatCommand({ command: 'x', exitCode: 0, output: 'hello\n' }, { always: true });
  assert.match(out, /hello/);
});
