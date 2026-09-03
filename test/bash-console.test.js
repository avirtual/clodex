'use strict';
// bash-console.js — the Bash-console reader: it turns the raw hook JSON the
// append script dumps into the blocks the drawer renders.
//
// THE WHOLE POINT OF THIS FILE is the two-shape problem. A SUCCEEDING Bash call
// fires PostToolUse and carries `tool_response`; a FAILING one fires
// PostToolUseFailure, which has no `tool_response` at all and puts the output in
// a top-level `error` string with the exit code concatenated onto the front. A
// reader written against only the first shape yields a console that silently
// omits exactly the commands an operator opens it for, so every test below that
// names the failure arm is guarding a real omission rather than a branch.
//
// The payload fixtures are VERBATIM captures from claude 2.1.259 (probed live
// while this was built), trimmed only of fields the reader ignores. Hand-written
// approximations would let the reader stay green against a shape the CLI never
// sends, which is the one failure this module cannot survive.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  CONSOLE_MAX_BYTES, PULL_MAX_BYTES, PULL_MAX_RECORDS,
  stripAnsi, splitFailure, normalizeRecord, parseChunk, readBashConsole,
} = require('../bash-console');
const { pathFor, runDirFor } = require('../clodex-paths');

// A real PostToolUse payload for `printf "OUT1\nERR1\n"; printf "E2\n" >&2`.
// The interleaving is the measured fact: stdout and stderr arrive ALREADY
// MERGED in chronological order in `.stdout`, with `.stderr` empty.
const OK_PAYLOAD = {
  session_id: 's1',
  cwd: '/private/tmp/t645p2',
  hook_event_name: 'PostToolUse',
  tool_name: 'Bash',
  tool_input: { command: 'printf "OUT1\\nERR1\\n"; printf "E2\\n" >&2' },
  tool_response: {
    stdout: 'OUT1\nERR1\nE2', stderr: '', interrupted: false, isImage: false, noOutputExpected: false,
  },
  tool_use_id: 'toolu_ok',
  duration_ms: 310,
};

// A real PostToolUseFailure payload for `cat /nope/definitely-missing-t645`.
// Note what is ABSENT: no tool_response key whatsoever.
const FAIL_PAYLOAD = {
  session_id: 's1',
  cwd: '/private/tmp/t645p2',
  hook_event_name: 'PostToolUseFailure',
  tool_name: 'Bash',
  tool_input: { command: 'cat /nope/definitely-missing-t645' },
  tool_use_id: 'toolu_fail',
  error: 'Exit code 1\ncat: /nope/definitely-missing-t645: No such file or directory',
  is_interrupt: false,
  duration_ms: 17,
};

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'clx-console-'));
}

function writeLines(root, name, objs) {
  fs.mkdirSync(runDirFor(root, name), { recursive: true });
  const file = pathFor(root, name, 'bashConsole');
  fs.appendFileSync(file, objs.map((o) => JSON.stringify(o)).join('\n') + '\n');
  return file;
}

test('a succeeding call becomes a block whose output is the merged stream', () => {
  const rec = normalizeRecord(OK_PAYLOAD);
  // The WHOLE object, not a field probe: an unwired field arrives as undefined
  // and every individual assertion around it still passes.
  assert.deepStrictEqual(rec, {
    id: 'toolu_ok',
    command: 'printf "OUT1\\nERR1\\n"; printf "E2\\n" >&2',
    durationMs: 310,
    cwd: '/private/tmp/t645p2',
    agentId: null,
    failed: false,
    exitCode: 0,
    output: 'OUT1\nERR1\nE2',
    interrupted: false,
    timedOut: false,
    truncated: false,
    fullBytes: null,
  });
});

// The arm a PostToolUse-only implementation loses entirely.
test('a FAILING call becomes a failed block with its exit code split out', () => {
  const rec = normalizeRecord(FAIL_PAYLOAD);
  assert.deepStrictEqual(rec, {
    id: 'toolu_fail',
    command: 'cat /nope/definitely-missing-t645',
    durationMs: 17,
    cwd: '/private/tmp/t645p2',
    agentId: null,
    failed: true,
    exitCode: 1,
    output: 'cat: /nope/definitely-missing-t645: No such file or directory',
    interrupted: false,
    timedOut: false,
    truncated: false,
    fullBytes: null,
  });
});

// The exit code is INSIDE the error string, so the split is the only thing that
// makes "exit 1" showable. A changed prefix must not eat the output with it.
test('an error string with no Exit-code prefix keeps all its bytes', () => {
  assert.deepStrictEqual(splitFailure('something exploded'),
    { exitCode: null, output: 'something exploded' });
  assert.deepStrictEqual(splitFailure('Exit code 127\nnope: command not found'),
    { exitCode: 127, output: 'nope: command not found' });
});

test('an interrupted or timed-out failure is marked as such', () => {
  const rec = normalizeRecord({ ...FAIL_PAYLOAD, is_interrupt: true, is_timeout: true });
  assert.strictEqual(rec.interrupted, true);
  assert.strictEqual(rec.timedOut, true);
});

// Truncation must be visible, or the operator reads a cut result as the whole
// one. The CLI caps stdout at 30000 chars and only THEN adds the persisted pair.
test('a truncated response reports the true full size', () => {
  const rec = normalizeRecord({
    ...OK_PAYLOAD,
    tool_response: {
      stdout: 'x'.repeat(30000),
      stderr: '',
      interrupted: false,
      isImage: false,
      noOutputExpected: false,
      persistedOutputPath: '/Users/x/.claude/projects/p/s/tool-results/abc.txt',
      persistedOutputSize: 108894,
    },
  });
  assert.strictEqual(rec.truncated, true);
  assert.strictEqual(rec.fullBytes, 108894);
  assert.strictEqual(rec.output.length, 30000, 'the capped bytes are still shown');
});

test('a non-Bash tool and a commandless payload contribute no block', () => {
  assert.strictEqual(normalizeRecord({ ...OK_PAYLOAD, tool_name: 'Read' }), null);
  assert.strictEqual(normalizeRecord({ ...OK_PAYLOAD, tool_input: {} }), null);
  assert.strictEqual(normalizeRecord(null), null);
});

// A subagent's Bash calls fire the PARENT's hook, so they land in the parent's
// file. Keeping agent_id is what lets a reader tell them apart at all.
test('a subagent call keeps its agent_id', () => {
  assert.strictEqual(normalizeRecord({ ...OK_PAYLOAD, agent_id: 'abc123' }).agentId, 'abc123');
});

// Every escape below is built from its CODE POINT. A raw ESC typed into this
// file is invisible, does not reliably survive reformatting or an editor that
// sanitizes on save, and its loss would turn each case into an assertion about
// ordinary text that still passes. Same rule as drawer-avail.test.js's `ch`.
const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);

test('ANSI escapes and control bytes are stripped, printable text is not', () => {
  assert.strictEqual(stripAnsi(ESC + '[31mred' + ESC + '[0m plain'), 'red plain');
  assert.strictEqual(stripAnsi('a' + ESC + ']0;title' + BEL + 'b'), 'ab', 'an OSC title sequence');
  assert.strictEqual(stripAnsi('done' + ESC + '[2K' + ESC + '[1Gagain'), 'doneagain',
    'a progress-bar redraw, which is what long builds emit');
  assert.strictEqual(stripAnsi('x' + String.fromCharCode(0x00) + 'y'), 'xy', 'a bare NUL');
  // Tabs and newlines are CONTENT here — the pane renders them as layout.
  assert.strictEqual(stripAnsi('keep\ttabs\nand newlines'), 'keep\ttabs\nand newlines');
});

test('a corrupt line is skipped without aborting the batch around it', () => {
  const text = `${JSON.stringify(OK_PAYLOAD)}\n{not json\n${JSON.stringify(FAIL_PAYLOAD)}\n`;
  const recs = parseChunk(text);
  assert.strictEqual(recs.length, 2, 'ENTER: both real records survived the corrupt middle line');
  assert.deepStrictEqual(recs.map((r) => r.failed), [false, true]);
});

test('readBashConsole is incremental: a second read returns only what is new', () => {
  const root = tmp();
  writeLines(root, 'agent1', [OK_PAYLOAD]);

  const first = readBashConsole(root, 'agent1', 0);
  assert.strictEqual(first.live, true);
  assert.strictEqual(first.records.length, 1, 'ENTER: the first pull saw the first call');
  assert.ok(first.offset > 0);

  const idle = readBashConsole(root, 'agent1', first.offset);
  assert.deepStrictEqual(idle.records, [], 'nothing new means no records');
  assert.strictEqual(idle.offset, first.offset, 'and the offset does not move');

  writeLines(root, 'agent1', [FAIL_PAYLOAD]);
  const second = readBashConsole(root, 'agent1', idle.offset);
  assert.strictEqual(second.records.length, 1, 'only the NEW call, not both');
  assert.strictEqual(second.records[0].command, 'cat /nope/definitely-missing-t645');
});

// A seat with no console yet (no Bash call, or a codex seat) must read as empty
// rather than throwing — the tenant polls before the first call exists.
test('an absent file reads as not-live with no records', () => {
  const root = tmp();
  const res = readBashConsole(root, 'never-ran', 0);
  assert.deepStrictEqual(res, { records: [], offset: 0, reset: false, live: false });
});

// Rotation moves the file out from under a live reader, so the held offset now
// points past the end of a SHORTER file. Without the reset the reader would sit
// at that offset forever and the tab would silently stop updating.
test('an offset past the end signals a reset and re-reads from zero', () => {
  const root = tmp();
  writeLines(root, 'agent1', [OK_PAYLOAD, FAIL_PAYLOAD]);
  const big = readBashConsole(root, 'agent1', 0);
  assert.strictEqual(big.records.length, 2, 'ENTER: two records to be rotated away');

  fs.writeFileSync(pathFor(root, 'agent1', 'bashConsole'), `${JSON.stringify(OK_PAYLOAD)}\n`);
  const after = readBashConsole(root, 'agent1', big.offset);
  assert.strictEqual(after.reset, true, 'the reader must be told its view is stale');
  assert.strictEqual(after.records.length, 1, 'and re-read the shorter file from the start');
});

// A partial line is the normal state: the hook appends while the reader reads.
// Consuming it would corrupt the record AND advance the offset past it.
test('a half-written trailing line is left for the next read', () => {
  const root = tmp();
  fs.mkdirSync(runDirFor(root, 'agent1'), { recursive: true });
  const file = pathFor(root, 'agent1', 'bashConsole');
  const whole = `${JSON.stringify(OK_PAYLOAD)}\n`;
  const half = JSON.stringify(FAIL_PAYLOAD).slice(0, 40);
  fs.writeFileSync(file, whole + half);

  const res = readBashConsole(root, 'agent1', 0);
  assert.strictEqual(res.records.length, 1, 'only the complete record is returned');
  assert.strictEqual(res.offset, Buffer.byteLength(whole, 'utf8'),
    'the offset stops at the line break, so the partial line is re-read whole');

  fs.appendFileSync(file, JSON.stringify(FAIL_PAYLOAD).slice(40) + '\n');
  const next = readBashConsole(root, 'agent1', res.offset);
  assert.strictEqual(next.records.length, 1, 'ENTER: the completed line parsed on the next pull');
  assert.strictEqual(next.records[0].exitCode, 1, 'and it parsed as the real failure, not as garbage');
});

// A backlog must not arrive as one unbounded IPC reply. The offset still
// advances past everything read, so the drop is bounded and forward-only.
test('a large backlog is capped per pull but never re-read', () => {
  const root = tmp();
  const many = [];
  for (let i = 0; i < PULL_MAX_RECORDS + 20; i++) {
    many.push({ ...OK_PAYLOAD, tool_input: { command: `echo ${i}` } });
  }
  writeLines(root, 'agent1', many);
  const res = readBashConsole(root, 'agent1', 0);
  assert.strictEqual(res.records.length, PULL_MAX_RECORDS, 'the reply is capped');
  assert.strictEqual(res.records[res.records.length - 1].command,
    `echo ${many.length - 1}`, 'and it keeps the NEWEST, which is what the operator is watching');
  const after = readBashConsole(root, 'agent1', res.offset);
  assert.deepStrictEqual(after.records, [], 'the offset advanced past the whole batch');
});

test('the caps are real numbers in the right order', () => {
  assert.strictEqual(CONSOLE_MAX_BYTES, 4 * 1024 * 1024);
  assert.ok(PULL_MAX_BYTES < CONSOLE_MAX_BYTES,
    'one pull must not be able to carry the whole file');
  assert.ok(PULL_MAX_RECORDS > 0 && PULL_MAX_RECORDS < 1000);
});
