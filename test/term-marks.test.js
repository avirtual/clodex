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
  assert.deepStrictEqual(recs[0], { command: 'echo hi', exitCode: 0, output: 'hi\n', depth: 0 });
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
  assert.deepStrictEqual(recs[0], { command: 'ls', exitCode: 0, output: 'a\n', depth: 0 });
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
  assert.deepStrictEqual(recs[0], { command: 'real', exitCode: 0, output: 'mine\n', depth: 0 });
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

// --- the abandon signal ---------------------------------------------------
// The drop above is right; doing it SILENTLY is what was wrong. Nothing else in
// the stream ever mentions an abandoned command again, so anything waiting on it
// waits forever. These pin the announcement without changing what is dropped.

test('an abandoned command is ANNOUNCED, carrying what was abandoned', () => {
  const dropped = [];
  const recs = [];
  const p = createMarkParser({ onCommand: (r) => recs.push(r), onAbandon: (r) => dropped.push(r) });
  p.feed(`${A}${C('sleep 900')}partial output\n${A}`);

  assert.deepStrictEqual(recs, [], 'still not reported as a command that ran');
  assert.strictEqual(dropped.length, 1, 'ENTER: the drop was announced');
  // The command TEXT rides along: "something you asked for was abandoned" is not
  // actionable for a consumer that may have several commands in flight.
  assert.deepStrictEqual(dropped[0], { command: 'sleep 900', output: 'partial output\n', depth: 0 });
  // No exitCode field at all. There is none, and inventing 130 would claim a
  // SIGINT that may not be what happened — the shell may simply have reset.
  assert.ok(!('exitCode' in dropped[0]), 'an abandoned command has no exit status');
});

test('a prompt with nothing open announces nothing', () => {
  // A is emitted before EVERY prompt, so an unconditional announcement would
  // fire on every keystroke-free redraw in the operator's terminal.
  const dropped = [];
  const p = createMarkParser({ onAbandon: (r) => dropped.push(r) });
  p.feed(`${A}${A}${D(0)}${A}`);
  assert.deepStrictEqual(dropped, []);
});

test('a command that FINISHED is not also announced as abandoned', () => {
  // The A that follows every D closes the prompt cycle. If emit() left the
  // capture open, that A would report every successful command as abandoned too.
  const recs = [];
  const dropped = [];
  const p = createMarkParser({ onCommand: (r) => recs.push(r), onAbandon: (r) => dropped.push(r) });
  p.feed(`${A}${C('ls')}x\n${D(0)}${A}`);
  assert.strictEqual(recs.length, 1, 'ENTER: it was reported as a finished command');
  assert.deepStrictEqual(dropped, [], 'and not a second time as abandoned');
});

test('the abandoned state is cleared, so the next command is clean', () => {
  const recs = [];
  const dropped = [];
  const p = createMarkParser({ onCommand: (r) => recs.push(r), onAbandon: (r) => dropped.push(r) });
  p.feed(`${C('abandoned')}stale\n${A}${C('real')}mine\n${D(0)}`);

  assert.strictEqual(dropped.length, 1, 'ENTER: the first was announced as abandoned');
  assert.deepStrictEqual(recs, [{ command: 'real', exitCode: 0, output: 'mine\n', depth: 0 }],
    "the abandoned command's output did not leak into the next one");
});

test('no onAbandon listener is not an error — the drop is still a drop', () => {
  // Every passive consumer omits it: an operator Ctrl-C'ing their own command is
  // not news to report, only news to whoever was waiting on it.
  const { recs, parser } = collect();
  parser.feed(`${A}${C('rm -rf /')}${A}${C('real')}x\n${D(0)}`);
  assert.deepStrictEqual(recs, [{ command: 'real', exitCode: 0, output: 'x\n', depth: 0 }]);
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

// The passive firehose has no idea what ran, so it keeps the drop above. A
// caller that ASKED knows what it sent, and losing a correct exit code and
// correct output to a missing LABEL answered nothing — which is what shipped in
// v5.1.x, on every repeated command under a stock ubuntu's HISTCONTROL.
test('an unnamed record is reported under the assumed command, with its output', () => {
  const out = formatCommand({ command: '', exitCode: 0, output: '/home/clodex\n' },
    { always: true, assumed: 'pwd' });
  assert.match(out, /^\[terminal\] pwd \(assumed\)\nexit 0/, 'the assumed command names the report');
  assert.match(out, /\/home\/clodex/, 'the output survives — losing it is the defect');
});

// NEVER SILENTLY CLAIMED. drawer-pty's foreignRecord tells our command from the
// operator's by comparing the reported TEXT, so an unnamed record is exactly the
// one it cannot vet: an operator pressing Enter inside the exec race window has
// their output delivered here under our name. A message that claimed the shell
// reported it would be a confident lie about whose work it is.
test('an assumed command SAYS it was assumed, and says the output may be the operator\'s', () => {
  const out = formatCommand({ command: '', exitCode: 0, output: 'x' },
    { always: true, assumed: 'pwd' });
  assert.match(out, /did not name the command/, 'the doubt is stated');
  assert.match(out, /may be theirs/, 'and whose output it might be');
  // ON THE LINE THE AGENT QUOTES, not only in the paragraph under it. Frequency
  // is the argument: under a stock ubuntu's HISTCONTROL this is the answer to
  // every repeated command, and a parenthetical read hourly stops being read.
  assert.strictEqual(out.split('\n')[0], '[terminal] pwd (assumed)',
    'the first line is what gets quoted back, so the doubt has to survive being quoted');
});

test('a NAMED record carries no assumption notice even when assumed is passed', () => {
  const out = formatCommand({ command: 'pwd', exitCode: 0, output: 'x' },
    { always: true, assumed: 'pwd' });
  assert.ok(!/did not name the command/.test(out),
    'the shell DID say — hedging a reported command would train the agent to discount the notice');
  assert.strictEqual(out.split('\n')[0], '[terminal] pwd',
    'and no marker on the quoted line either, for the same reason');
});

// The passive path passes no `assumed`, and this is the whole reason the option
// exists rather than a change to the default: nobody asked for that report, so a
// command that cannot be named is not worth the operator's privacy.
test('an unnamed record is still dropped when no assumed command is given', () => {
  assert.strictEqual(formatCommand({ command: '', exitCode: 0, output: 'x' }, { always: true }), null);
  assert.strictEqual(formatCommand({ command: '', exitCode: 0, output: 'x' }, { assumed: '  ' }), null);
});

// `assumed` lets a caller clear the name guard with no record at all, which the
// old `rec.exitCode` read would have thrown on.
test('an assumed command with no record at all is reported, as an unknown exit', () => {
  const out = formatCommand(null, { always: true, assumed: 'pwd' });
  assert.match(out, /^\[terminal\] pwd \(assumed\)\nexit unknown/);
});

test('an unknown exit code is stated as unknown, not as success', () => {
  const out = formatCommand({ command: 'x', exitCode: null, output: '' });
  assert.match(out, /exit unknown/);
});

test('always:true carries output for a successful command', () => {
  const out = formatCommand({ command: 'x', exitCode: 0, output: 'hello\n' }, { always: true });
  assert.match(out, /hello/);
});

// WHICH CALLER PASSES `assumed` IS THE WHOLE PRIVACY RULE, and neither call site
// is reachable from a test: engine.js requires node-pty at module load, so there
// is no way to stand up a shell whose result would arrive here. Pinned at the
// SOURCE, in the style term-shim.test.js already uses for the same reason — a
// weaker statement than a behavioural test, and here because the alternative
// measures nothing at all.
test('engine passes `assumed` on the asked path only, and never on the firehose', () => {
  const src = require('fs').readFileSync(require.resolve('../engine.js'), 'utf8');
  const calls = src.match(/formatCommand\([^)]*\)/g) || [];
  assert.strictEqual(calls.length, 2, 'ENTER: both call sites were found');
  const [passive, asked] = calls;
  assert.match(passive, /formatCommand\(rec, \{ stripAnsi \}\)/,
    'the firehose stays unnamed-and-dropped — nobody asked, so an unnameable command is not worth the operator\'s privacy');
  assert.match(asked, /assumed: res\.command/, 'the agent asked, so it gets an answer');
  // The `|| "…did not report which command ran"` fallback this replaced threw
  // the exit code and the output away. If it comes back, so does the defect.
  assert.ok(!/did not report which command ran/.test(src),
    'the discard-the-answer fallback must not return');
});

// ── the interrupt flag on onPrompt ──────────────────────────────────────────
// `interrupted` says ONE thing: the last command to finish exited 128+SIGINT.
// drawer-pty's exec() uses it to tell a prompt that followed an interrupt from
// one that is only a redraw. It is deliberately NOT a claim about WHOSE
// interrupt — `$?` is latched and the shim re-emits the pair every prompt cycle
// until a command runs — so these pin the pairing rule and nothing stronger.

test('onPrompt reports interrupted only for the A its own D;130 precedes', () => {
  const seen = [];
  const p = createMarkParser({ onPrompt: (i) => seen.push(i && i.interrupted) });

  p.feed(`${D(130)}${A}`);
  p.feed(`${D(0)}${A}`);
  p.feed(A);
  assert.deepStrictEqual(seen, [true, false, false],
    'the interrupt status belongs to one A: not the next prompt, not a bare redraw');
});

test('output between a D and an A breaks the pair', () => {
  // Our own shim prints both from one precmd with nothing in between, verified
  // in term-shim.js for both shells and measured on real zsh and bash at zero
  // bytes between them — so this never fires for us. It fires when a SECOND,
  // independently sequenced OSC 133 stream shares the terminal (iTerm2's or
  // VSCode's shell integration), where an unrelated A would otherwise inherit
  // our D's status and release a command early.
  const seen = [];
  const p = createMarkParser({ onPrompt: (i) => seen.push(i && i.interrupted) });

  p.feed(D(130));
  p.feed('output from another integration\r\n');
  p.feed(A);
  assert.deepStrictEqual(seen, [false],
    'an A separated from the D by output is not that D`s prompt');
});

test('current() names the open command between C and D, and is empty after it', () => {
  const p = createMarkParser({ onCommand: () => {} });
  assert.strictEqual(p.current(), '', 'ENTER: nothing is open before any C');

  p.feed(`${A}${C('ssh bogdan@example')}`);
  assert.strictEqual(p.isBusy(), true);
  assert.strictEqual(p.current(), 'ssh bogdan@example');

  p.feed(`${D(0)}${A}`);
  assert.strictEqual(p.isBusy(), false);
  assert.strictEqual(p.current(), '', 'a finished command is no longer the one holding the tab');
});

test('an abandoned command is not still reported as the one holding the tab', () => {
  const p = createMarkParser({ onCommand: () => {} });
  p.feed(`${C('ssh bogdan@example')}`);
  assert.strictEqual(p.current(), 'ssh bogdan@example', 'ENTER: the line is open');

  p.feed(A);
  assert.strictEqual(p.current(), '', 'the abandon cleared it, so no refusal can name a dead command');
});

const TC = (cmd) => `\x1b]133;C;${b64(cmd)};nest=1\x07`;
const TD = (code) => `\x1b]133;D;${code};nest=1\x07`;
const TA = '\x1b]133;A;nest=1\x07';

function twoLayer() {
  const events = [];
  const parser = createMarkParser({
    onCommand: (r) => events.push(['command', r]),
    onAbandon: (r) => events.push(['abandon', r]),
    onPrompt: (i) => events.push(['prompt', i]),
  });
  return { events, parser, recs: () => events.filter((e) => e[0] === 'command').map((e) => e[1]) };
}

test('a tagged command inside an open outer is a depth-1 record and does not close the outer', () => {
  const { parser, recs } = twoLayer();
  parser.feed(`${A}${C('ssh host')}`);
  assert.strictEqual(parser.isBusy(), true, 'ENTER: the outer holds the tab');

  parser.feed(`${TC('ls')}a.txt\n${TD(0)}`);
  assert.deepStrictEqual(recs(), [{
    command: 'ls', exitCode: 0, output: 'a.txt\n', depth: 1, inside: 'ssh host',
  }]);
  assert.strictEqual(parser.isBusy(), true, 'ssh still holds the tab — the far command finishing did not free it');
  assert.strictEqual(parser.current(), 'ssh host', 'and the tab is still named by the OUTER command');
  assert.strictEqual(parser.innerCurrent(), '', 'the far layer is idle again');
  assert.strictEqual(parser.innerBusy(), false);
});

test('a tagged abandon drops the inner only, and its prompt carries depth 1', () => {
  const { events, parser } = twoLayer();
  parser.feed(`${C('ssh host')}${TC('sleep 900')}partial\n`);
  assert.strictEqual(parser.innerBusy(), true, 'ENTER: the far command is open');

  parser.feed(TA);
  const abandons = events.filter((e) => e[0] === 'abandon');
  assert.strictEqual(abandons.length, 1, 'exactly one abandon — the outer was not also dropped');
  assert.deepStrictEqual(abandons[0][1], {
    command: 'sleep 900', output: 'partial\n', depth: 1, inside: 'ssh host',
  });
  assert.strictEqual(parser.isBusy(), true, 'the outer survived its far side being interrupted');
  assert.deepStrictEqual(events.filter((e) => e[0] === 'prompt').map((e) => e[1]),
    [{ interrupted: false, depth: 1 }]);
});

test('ssh exiting settles the far command BEFORE the outer, with no status of its own', () => {
  const { events, parser } = twoLayer();
  parser.feed(`${C('ssh host')}${TC('apt upgrade')}working\n`);
  assert.strictEqual(parser.innerBusy(), true, 'ENTER: the far command is open inside an open outer');

  parser.feed(`${D(0)}${A}`);
  const order = events.filter((e) => e[0] === 'command').map((e) => e[1]);
  assert.strictEqual(order.length, 2, 'both layers settled');
  assert.deepStrictEqual(order[0], {
    command: 'apt upgrade', exitCode: null, output: 'working\n',
    depth: 1, inside: 'ssh host', sessionEnded: true,
  }, 'the INNER is first, and says the session ended rather than inventing an exit code');
  assert.deepStrictEqual(order[1], {
    command: 'ssh host', exitCode: 0, output: 'working\n', depth: 0,
  }, 'the outer follows, with its own real exit code');
  assert.strictEqual(parser.isBusy(), false);
  assert.strictEqual(parser.innerBusy(), false);
});

test('an interrupt at the far prompt reports depth 0 on the outer A and still session-ends the inner', () => {
  const { events, parser } = twoLayer();
  parser.feed(`${C('ssh host')}${TC('sleep 900')}`);
  parser.feed(`${D(130)}${A}`);

  const recs = events.filter((e) => e[0] === 'command').map((e) => e[1]);
  assert.strictEqual(recs[0].sessionEnded, true, 'ENTER: the inner was session-ended');
  assert.deepStrictEqual(events.filter((e) => e[0] === 'prompt').map((e) => e[1]),
    [{ interrupted: true, depth: 0 }], 'the depth is on the EVENT: this prompt is the local shell`s');
});

test('a tagged D;130 then a tagged A reports the interrupt at depth 1', () => {
  const { events, parser } = twoLayer();
  parser.feed(`${C('ssh host')}${TC('sleep 900')}`);
  parser.feed(`${TD(130)}${TA}`);
  assert.deepStrictEqual(events.filter((e) => e[0] === 'prompt').map((e) => e[1]),
    [{ interrupted: true, depth: 1 }]);
  assert.strictEqual(parser.isBusy(), true, 'the outer is untouched by either');
});

test('tagged marks with no outer open are ignored, and never reach the output', () => {
  const { events, parser } = twoLayer();
  parser.feed(`${TC('ls')}stray\n${TD(0)}${TA}`);
  assert.deepStrictEqual(events.filter((e) => e[0] !== 'prompt'), [], 'nothing was framed');
  assert.strictEqual(parser.innerBusy(), false);

  parser.feed(`${C('real')}mine\n${D(0)}`);
  const recs = events.filter((e) => e[0] === 'command').map((e) => e[1]);
  assert.deepStrictEqual(recs, [{ command: 'real', exitCode: 0, output: 'mine\n', depth: 0 }],
    'and the stray bytes did not leak into the next real command');
});

test('a nest level we do not understand is stripped and changes nothing', () => {
  const { events, parser } = twoLayer();
  parser.feed(`${C('ssh host')}${TC('bash')}`);
  const before = parser._state();
  assert.strictEqual(before.inner.capturing, true, 'ENTER: the far shell has a command open');

  parser.feed(`\x1b]133;C;${b64('deeper')};nest=2\x07mid\n\x1b]133;D;0;nest=2\x07`);
  assert.deepStrictEqual(events.filter((e) => e[0] !== 'prompt'), [], 'no record, no abandon');
  const after = parser._state();
  assert.strictEqual(after.inner.command, 'bash', 'the depth-1 capture is untouched');
  assert.strictEqual(after.capturing, true);

  parser.feed(TD(0));
  const recs = events.filter((e) => e[0] === 'command').map((e) => e[1]);
  assert.strictEqual(recs.length, 1);
  assert.ok(!/133|nest=2/.test(recs[0].output), 'the unknown mark`s bytes were stripped, not captured');
  assert.strictEqual(recs[0].output, 'mid\n', 'the text around it still is');
});

test('a new outer command resets a far capture and bumps outerSeq', () => {
  const { events, parser } = twoLayer();
  assert.strictEqual(parser.outerSeq(), 0, 'ENTER: no outer command has run');

  parser.feed(`${C('ssh host')}`);
  assert.strictEqual(parser.outerSeq(), 1);
  parser.feed(TC('sleep 900'));
  parser.feed(`${C('ssh other')}`);

  assert.strictEqual(parser.outerSeq(), 2, 'the second session is a different instance');
  assert.strictEqual(parser.innerBusy(), false, 'a new outer command cannot have the old far side still open');
  assert.deepStrictEqual(events.filter((e) => e[0] === 'command'), [],
    'the reset is silent — nothing ran to report');
});

test('an abandoned outer resets the far layer too', () => {
  const { parser } = twoLayer();
  parser.feed(`${C('ssh host')}${TC('sleep 900')}`);
  assert.strictEqual(parser.innerBusy(), true, 'ENTER: both layers are open');

  parser.feed(A);
  assert.strictEqual(parser.isBusy(), false);
  assert.strictEqual(parser.innerBusy(), false, 'an abandoned outer has no far side');
});

test('altScreen tracks the switch even when a PTY read splits it', () => {
  const { parser } = twoLayer();
  assert.strictEqual(parser.altScreen(), false, 'ENTER: the far side is at a shell prompt');

  parser.feed('\x1b[?10');
  parser.feed('49h');
  assert.strictEqual(parser.altScreen(), true, 'the halves were stitched across the feeds');

  parser.feed('\x1b[?1049l');
  assert.strictEqual(parser.altScreen(), false, 'leaving it clears the flag');
});

test('the alt-screen bytes still reach the captured output', () => {
  const { recs, parser } = collect();
  parser.feed(`${C('vim x')}\x1b[?1049hscreen\x1b[?1049l${D(0)}`);
  assert.strictEqual(recs.length, 1, 'ENTER: the command was framed');
  assert.strictEqual(recs[0].output, '\x1b[?1049hscreen\x1b[?1049l',
    'the parser reads the switch, it does not consume it — the screen must still render');
});

test('the older 47 and 1047 switches count too', () => {
  const { parser } = twoLayer();
  parser.feed('\x1b[?47h');
  assert.strictEqual(parser.altScreen(), true);
  parser.feed('\x1b[?47l');
  assert.strictEqual(parser.altScreen(), false);
  parser.feed('\x1b[?1047h');
  assert.strictEqual(parser.altScreen(), true);
});

test('an untagged mark clears altScreen — the local shell is back', () => {
  const { parser } = twoLayer();
  parser.feed(`${C('ssh host')}\x1b[?1049h`);
  assert.strictEqual(parser.altScreen(), true, 'ENTER: the far side took the screen');

  parser.feed(`${D(0)}`);
  assert.strictEqual(parser.altScreen(), false, 'ssh exited, so nothing remote has the screen');
  assert.strictEqual(parser._state().altScreen, false);
});

test('a depth-1 record says which session it ran inside', () => {
  const out = formatCommand({ command: 'apt list --upgradable', exitCode: 0, output: '' },
    { inside: 'ssh deploy@web-1' });
  assert.strictEqual(out, '[terminal] apt list --upgradable\nran inside `ssh deploy@web-1`\nexit 0');
});

test('the session line sits between the command and its status, and survives output', () => {
  const out = formatCommand({ command: 'false', exitCode: 1, output: 'boom\n' },
    { inside: 'ssh host' });
  assert.deepStrictEqual(out.split('\n').slice(0, 3),
    ['[terminal] false', 'ran inside `ssh host`', 'exit 1']);
  assert.match(out, /boom/);
});

test('a local command carries no session line at all', () => {
  const out = formatCommand({ command: 'ls', exitCode: 0, output: '' });
  assert.strictEqual(out, '[terminal] ls\nexit 0');
  assert.strictEqual(formatCommand({ command: 'ls', exitCode: 0, output: '' }, { inside: '' }),
    '[terminal] ls\nexit 0', 'an empty inside is not a session');
});

test('an A carrying another integration`s attributes is ignored, not an abandon', () => {
  const { events, parser } = twoLayer();
  parser.feed(`${C('npm test')}running\n`);
  assert.strictEqual(parser.isBusy(), true, 'ENTER: our command is open and capturing');

  for (const attrs of ['k=s', 'cl=m', 'aid=1234', 'k=s;cl=m']) {
    parser.feed(`\x1b]133;A;${attrs}\x07`);
  }
  assert.deepStrictEqual(events, [],
    'no abandon and no prompt: kitty emits A;k=s on a continuation prompt, and an abandon would tell the agent its running command died');
  assert.strictEqual(parser.isBusy(), true, 'the capture is still open');

  parser.feed(`more\n${D(0)}`);
  const recs = events.filter((e) => e[0] === 'command').map((e) => e[1]);
  assert.deepStrictEqual(recs, [{
    command: 'npm test', exitCode: 0, output: 'running\nmore\n', depth: 0,
  }], 'the real D still finds the capture and reports the true result');
  assert.ok(!/133|k=s|aid=/.test(recs[0].output), 'and the foreign marks were stripped from it');
});

test('a foreign A does not disturb an open far capture either', () => {
  const { events, parser } = twoLayer();
  parser.feed(`${C('ssh host')}${TC('apt upgrade')}`);
  assert.strictEqual(parser.innerBusy(), true, 'ENTER: both layers are open');

  parser.feed('\x1b]133;A;aid=7\x07');
  assert.deepStrictEqual(events, [], 'neither layer was settled');
  assert.strictEqual(parser.innerBusy(), true, 'the far capture survived — innerClear() did not run');
  assert.strictEqual(parser.isBusy(), true);
});
