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
//
// ONE RECORD PER FILE, claimed by atomic rename, because the CLI fires Bash hooks
// CONCURRENTLY. The first shape of this feature appended to a shared JSONL and
// lost records: measured, four concurrent writers left 1/20 records parseable at
// 400-byte payloads, and the loss was SILENT because a damaged line fails
// JSON.parse and is skipped. `printf '%s\n' "$(cat)"` as a single write is NOT
// sufficient either (12/40) — a 35KB append is not atomic on APFS. The test that
// holds that line drives the real generated hook, so it lives in cli-hooks.test.js
// ('loses nothing when Bash hooks fire concurrently').

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  CONSOLE_MAX_RECORDS, RECORD_MAX_BYTES, PULL_MAX_RECORDS, RECORD_NAME_RE,
  stripAnsi, splitFailure, normalizeRecord, readBashConsole,
} = require('../bash-console');
const { pathFor } = require('../clodex-paths');

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

function spoolDir(root, name) {
  const dir = pathFor(root, name, 'bashConsole');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// The hook's own naming: <epoch-ns>-<pid>.json, fixed-width so lexicographic
// order IS chronological order. Returns the basename, which is the cursor.
function writeRecord(root, name, obj, stamp) {
  const base = `${stamp}-9.json`;
  fs.writeFileSync(path.join(spoolDir(root, name), base), JSON.stringify(obj));
  return base;
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

test('readBashConsole is incremental: a second read returns only what is new', () => {
  const root = tmp();
  writeRecord(root, 'agent1', OK_PAYLOAD, '00000000000000000001');

  const first = readBashConsole(root, 'agent1', '');
  assert.strictEqual(first.live, true);
  assert.strictEqual(first.records.length, 1, 'ENTER: the first pull saw the first call');
  assert.ok(first.cursor, 'and handed back a cursor to resume from');

  const idle = readBashConsole(root, 'agent1', first.cursor);
  assert.deepStrictEqual(idle.records, [], 'nothing new means no records');
  assert.strictEqual(idle.cursor, first.cursor, 'and the cursor does not move');

  writeRecord(root, 'agent1', FAIL_PAYLOAD, '00000000000000000002');
  const second = readBashConsole(root, 'agent1', idle.cursor);
  assert.strictEqual(second.records.length, 1, 'only the NEW call, not both');
  assert.strictEqual(second.records[0].command, 'cat /nope/definitely-missing-t645');
});

// A seat with no console yet (no Bash call, or a codex seat) must read as empty
// rather than throwing — the tenant polls before the first call exists.
test('an absent spool reads as not-live with no records', () => {
  const root = tmp();
  const res = readBashConsole(root, 'never-ran', '');
  assert.deepStrictEqual(res, { records: [], cursor: '', reset: false, skipped: 0, live: false });
});

// The prune drops the OLDEST records, so a reader whose cursor names a pruned
// record has a GAP it cannot fill. Saying so lets the tenant redraw instead of
// stitching new blocks onto a history that is missing its middle.
test('a cursor whose record was pruned away reports a reset', () => {
  const root = tmp();
  writeRecord(root, 'agent1', OK_PAYLOAD, '00000000000000000005');
  const stale = '00000000000000000001-1.json';   // older than everything present
  const res = readBashConsole(root, 'agent1', stale);
  assert.strictEqual(res.reset, true, 'the reader must be told its continuity broke');
  assert.strictEqual(res.records.length, 1, 'and get everything that survived');
});

test('an ordinary resume is NOT reported as a reset', () => {
  const root = tmp();
  const a = writeRecord(root, 'agent1', OK_PAYLOAD, '00000000000000000001');
  writeRecord(root, 'agent1', FAIL_PAYLOAD, '00000000000000000002');
  const res = readBashConsole(root, 'agent1', a);
  assert.strictEqual(res.reset, false,
    'the cursor record is still on disk, so nothing was missed');
  assert.strictEqual(res.records.length, 1, 'ENTER: it still returned the newer record');
});

// A record is a whole file claimed by rename, so a reader can never see a
// half-written one — but a truncated or corrupt file must not abort the batch.
test('a corrupt record file is skipped without losing its neighbours', () => {
  const root = tmp();
  writeRecord(root, 'agent1', OK_PAYLOAD, '00000000000000000001');
  fs.writeFileSync(path.join(spoolDir(root, 'agent1'), '00000000000000000002-9.json'), '{not json');
  writeRecord(root, 'agent1', FAIL_PAYLOAD, '00000000000000000003');

  const res = readBashConsole(root, 'agent1', '');
  assert.strictEqual(res.records.length, 2, 'ENTER: both real records survived the corrupt middle file');
  assert.deepStrictEqual(res.records.map((r) => r.failed), [false, true]);
  assert.strictEqual(res.cursor, '00000000000000000003-9.json',
    'the cursor advances past the corrupt file so it is not re-read forever');
});

// The in-flight `.tmp.<pid>` a writer is still filling must be invisible: it is
// not yet a record, and reading it is exactly the torn read the rename prevents.
test('an in-flight .tmp file is not a record', () => {
  const root = tmp();
  writeRecord(root, 'agent1', OK_PAYLOAD, '00000000000000000001');
  fs.writeFileSync(path.join(spoolDir(root, 'agent1'), '.tmp.4242'), '{"partial":');
  const res = readBashConsole(root, 'agent1', '');
  assert.strictEqual(res.records.length, 1, 'only the renamed record counts');
});

// A backlog must not arrive as one unbounded IPC reply. The cursor still
// advances past everything considered, so the drop is bounded and forward-only —
// and `skipped` COUNTS what it dropped, because a seat that ran 300 calls while
// the operator watched another tab would otherwise lose 250 of them with the
// pane showing no sign that anything was missing.
test('a large backlog is capped per pull, and says how many it dropped', () => {
  const root = tmp();
  const total = PULL_MAX_RECORDS + 20;
  for (let i = 0; i < total; i++) {
    writeRecord(root, 'agent1',
      { ...OK_PAYLOAD, tool_input: { command: `echo ${i}` } },
      String(i).padStart(20, '0'));
  }
  const res = readBashConsole(root, 'agent1', '');
  assert.strictEqual(res.records.length, PULL_MAX_RECORDS, 'the reply is capped');
  assert.strictEqual(res.records[res.records.length - 1].command, `echo ${total - 1}`,
    'and it keeps the NEWEST, which is what the operator is watching');
  assert.strictEqual(res.skipped, 20,
    'the 20 it could not carry are REPORTED, not dropped in silence');
  const after = readBashConsole(root, 'agent1', res.cursor);
  assert.deepStrictEqual(after.records, [], 'the cursor advanced past the whole batch');
  assert.strictEqual(after.skipped, 0, 'and an idle pull reports no gap');
});

// THE TIE IS THE POINT of this group, and it is not hypothetical: `date +%s%N`
// is a GNU/FreeBSD-14.1 extension, and on a `date` without it the hook falls
// back to whole seconds, so every record in the same second shares one stamp and
// is ordered only by pid. A strict `f > cursor` scan then drops every tie that
// sorts after the record the cursor named — silently, which is the round-1
// record-loss defect arriving through the reader instead of the writer. So the
// reader re-serves the cursor's whole timestamp group and the tenant dedupes on
// `key`. Both halves are needed: the scan alone omits, the re-serve alone
// repeats.
test('a record tying the cursor stamp but sorting BEFORE it is still served', () => {
  const root = tmp();
  const dir = spoolDir(root, 'agent1');
  // Same whole-second stamp, ordered by pid: the cursor names the HIGHER pid, so
  // a strict > scan would drop the lower one forever.
  fs.writeFileSync(path.join(dir, '00000000000000000007-8.json'),
    JSON.stringify({ ...OK_PAYLOAD, tool_input: { command: 'echo lower-pid' } }));
  fs.writeFileSync(path.join(dir, '00000000000000000007-9.json'),
    JSON.stringify({ ...OK_PAYLOAD, tool_input: { command: 'echo higher-pid' } }));

  const res = readBashConsole(root, 'agent1', '00000000000000000007-9.json');
  assert.deepStrictEqual(res.records.map((r) => r.command), ['echo lower-pid'],
    'the tie that sorts below the cursor must still reach the pane');
  assert.strictEqual(res.reset, false, 'and it is a resume, not a broken history');
});

// Cost of the tolerance above: a pull can re-serve a record the pane already
// drew. Every record therefore carries the basename it came from, which the
// atomic rename makes unique by construction — `tool_use_id` is a payload field
// a malformed record could lack, a filename is not.
test('every record carries its spool basename as a dedupe key', () => {
  const root = tmp();
  const a = writeRecord(root, 'agent1', OK_PAYLOAD, '00000000000000000001');
  const b = writeRecord(root, 'agent1', FAIL_PAYLOAD, '00000000000000000002');
  const res = readBashConsole(root, 'agent1', '');
  assert.deepStrictEqual(res.records.map((r) => r.key), [a, b],
    'ENTER: both records arrived, each keyed by the file the rename claimed');
  assert.strictEqual(new Set(res.records.map((r) => r.key)).size, 2, 'and the keys are distinct');
});

// The cursor must never move BACKWARDS. It can only be re-served now, and a
// cursor that regressed to the bottom of a tie group would re-serve that group
// on every poll forever.
test('the cursor never moves backwards when a tie group is re-served', () => {
  const root = tmp();
  const dir = spoolDir(root, 'agent1');
  fs.writeFileSync(path.join(dir, '00000000000000000007-8.json'), JSON.stringify(OK_PAYLOAD));
  fs.writeFileSync(path.join(dir, '00000000000000000007-9.json'), JSON.stringify(OK_PAYLOAD));
  const cursor = '00000000000000000007-9.json';
  const res = readBashConsole(root, 'agent1', cursor);
  assert.strictEqual(res.records.length, 1, 'ENTER: the tie really was re-served');
  assert.strictEqual(res.cursor, cursor, 'but the cursor held its high-water mark');
});

// The writer names the files and the ipc-handlers validator decides which
// cursors it will accept. They were two independent regex literals; a writer
// change that widened the name would have left the validator rejecting every
// cursor it produced, resetting the pane to 0 on every poll. One exported
// grammar, derived on both sides.
test('the cursor validator derives from the reader\'s exported name grammar', () => {
  const fs2 = require('node:fs');
  const src = fs2.readFileSync(path.join(__dirname, '..', 'ipc-handlers.js'), 'utf8');
  assert.ok(src.includes('RECORD_NAME_RE'),
    'ipc-handlers must USE the exported grammar, not restate it');
  assert.ok(!/\/\^\[0-9\]\{1,32\}-/.test(src),
    'and must not carry a second copy of the record-name literal');

  assert.ok(RECORD_NAME_RE.test('1788481092000000000-51198.json'), 'a real basename passes');
  assert.ok(!RECORD_NAME_RE.test('.tmp.4242'), 'an in-flight spool does not');
  assert.ok(!RECORD_NAME_RE.test('../../etc/passwd'), 'nor does a traversal');
  assert.ok(!RECORD_NAME_RE.test('1788481092N-51198.json'),
    'nor does the unguarded `date +%s%N` output this grammar exists to exclude');
});

// Anything the writer did not name is not a record. The prune counts `*.json`
// and the reader must agree with it, or the two disagree about what the cap
// retains.
test('a file outside the name grammar is not read as a record', () => {
  const root = tmp();
  const dir = spoolDir(root, 'agent1');
  writeRecord(root, 'agent1', OK_PAYLOAD, '00000000000000000001');
  fs.writeFileSync(path.join(dir, 'notes.json'), JSON.stringify(OK_PAYLOAD));
  fs.writeFileSync(path.join(dir, '1788481092N-77.json'), JSON.stringify(OK_PAYLOAD));
  const res = readBashConsole(root, 'agent1', '');
  assert.strictEqual(res.records.length, 1, 'only the correctly-named record counts');
});

test('the caps are real numbers in the right order', () => {
  assert.ok(PULL_MAX_RECORDS < CONSOLE_MAX_RECORDS,
    'one pull must not be able to carry the whole retained spool');
  assert.ok(PULL_MAX_RECORDS > 0 && PULL_MAX_RECORDS < 1000);
  // A single record is bounded well above the CLI's own 30000-char stdout cap,
  // so the guard only ever rejects something pathological.
  assert.ok(RECORD_MAX_BYTES > 30000 * 2);
});
