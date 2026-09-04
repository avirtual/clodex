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
  CONSOLE_MAX_RECORDS, RECORD_MAX_BYTES, PULL_MAX_RECORDS, BG_MAX_BYTES, RECORD_NAME_RE,
  stripAnsi, splitFailure, bgOutputPath, readBgOutput, normalizeRecord, readBashConsole,
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
    backgrounded: false,
    bgState: null,
    bgExitSeen: false,
    tailed: false,
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
    backgrounded: false,
    bgState: null,
    bgExitSeen: false,
    tailed: false,
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

// The reader is bounded by the cursor, NOT incremental: it re-serves the
// cursor's whole timestamp group every time, including the cursor's own record.
// It cannot do otherwise and stay correct — it is stateless across polls, and on
// a `date` without `%N` a whole second's records share one stamp, so any rule
// that drops part of that group drops records forever. Suppressing the repeat is
// the tenant's job (`lastKeys` in renderer/console-tab.js), and the two halves
// only compose: the reader alone repeats, the tenant alone never sees the ties.
test('a resume re-serves the cursor group and everything after it', () => {
  const root = tmp();
  writeRecord(root, 'agent1', OK_PAYLOAD, '00000000000000000001');

  const first = readBashConsole(root, 'agent1', '');
  assert.strictEqual(first.live, true);
  assert.strictEqual(first.records.length, 1, 'ENTER: the first pull saw the first call');
  assert.ok(first.cursor, 'and handed back a cursor to resume from');

  const idle = readBashConsole(root, 'agent1', first.cursor);
  assert.deepStrictEqual(idle.records.map((r) => r.key), [first.cursor],
    'an idle pull re-serves the cursor record itself, keyed for the tenant to drop');
  assert.strictEqual(idle.cursor, first.cursor, 'and the cursor does not move');

  writeRecord(root, 'agent1', FAIL_PAYLOAD, '00000000000000000002');
  const second = readBashConsole(root, 'agent1', idle.cursor);
  assert.deepStrictEqual(second.records.map((r) => r.command),
    ['printf "OUT1\\nERR1\\n"; printf "E2\\n" >&2', 'cat /nope/definitely-missing-t645'],
    'and a pull with something new carries the new record after the re-served one');
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
  assert.deepStrictEqual(res.records.map((r) => r.command),
    ['printf "OUT1\\nERR1\\n"; printf "E2\\n" >&2', 'cat /nope/definitely-missing-t645'],
    'ENTER: it still returned the newer record, behind the re-served cursor one');
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
  assert.deepStrictEqual(after.records.map((r) => r.key), [res.cursor],
    'the cursor advanced past the whole batch, leaving only its own record re-served');
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
  assert.deepStrictEqual(res.records.map((r) => r.command), ['echo lower-pid', 'echo higher-pid'],
    'the tie that sorts below the cursor must still reach the pane, and the whole group with it');
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
  assert.strictEqual(res.records.length, 2, 'ENTER: the whole tie group really was re-served');
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

// An auto-backgrounded call reaches the hook with stdout and stderr both EMPTY:
// measured on claude 2.1.260, 7 such responses across every seat spool on the
// author's box, 7 empty. The bytes are not lost, though — the task's output file
// OUTLIVES the call (unlike the foreground `persistedOutputPath`, which is
// unlinked at completion), and `scratchpad_dir` on the record names its parent.
// Every fixture below is built from the shape of a real captured record; the
// path derivation resolved 7/7 of the real ones.
const BG_PAYLOAD = {
  session_id: 'f700d388-0cd0-483f-ab33-5762ad039ac4',
  cwd: '/Users/bogdan/projects/tmux/wb-wrap-ui',
  scratchpad_dir: '/private/tmp/claude-501/-proj/f700d388/scratchpad',
  hook_event_name: 'PostToolUse',
  tool_name: 'Bash',
  tool_input: { command: 'npm run build' },
  tool_response: {
    stdout: '', stderr: '', interrupted: false, isImage: false,
    noOutputExpected: false, backgroundTaskId: 'babsrioq4',
  },
  tool_use_id: 'toolu_bg',
  duration_ms: 42,
};

// The output file is a SIBLING of the scratchpad dir, not a child: the CLI lays
// out <base>/<project>/<session>/{scratchpad,tasks}/ and names the file after
// the task id. Deriving it from the record is what makes the read possible at
// all — nothing in the payload carries the path itself.
function bgSpool(root, taskId, text) {
  const scratch = path.join(root, 'proj', 'sess', 'scratchpad');
  const tasks = path.join(root, 'proj', 'sess', 'tasks');
  fs.mkdirSync(tasks, { recursive: true });
  if (text !== null) fs.writeFileSync(path.join(tasks, `${taskId}.output`), text);
  return scratch;
}

test('a backgrounded call gets the output the hook never carried', () => {
  const root = tmp();
  const scratch = bgSpool(root, 'babsrioq4',
    'T648-BG-PROBE-LINE-1\nT648-BG-PROBE-STDERR\nT648-BG-PROBE-LINE-2\n\n[exited with code 0]\n');
  const rec = normalizeRecord({ ...BG_PAYLOAD, scratchpad_dir: scratch });

  assert.strictEqual(rec.bgState, 'attached', 'ENTER: the file really was found and read');
  assert.strictEqual(rec.output,
    'T648-BG-PROBE-LINE-1\nT648-BG-PROBE-STDERR\nT648-BG-PROBE-LINE-2',
    'the real bytes reach the pane, and the CLI exit trailer is not one of them');
  assert.strictEqual(rec.bgExitSeen, true, 'the trailer was there, so the exit code is evidence not inference');
  assert.strictEqual(rec.exitCode, 0);
  assert.strictEqual(rec.failed, false);
});

// The whole point of the ticket: before this, a dropped-output call and a
// genuinely silent one drew the same empty block. They must not be one state.
test('an absent task file is a DIFFERENT state from an empty one', () => {
  const gone = tmp();
  const goneRec = normalizeRecord({ ...BG_PAYLOAD, scratchpad_dir: bgSpool(gone, 'babsrioq4', null) });
  assert.strictEqual(goneRec.bgState, 'absent', 'no file at all: we cannot say what it printed');
  assert.strictEqual(goneRec.output, '');

  const quiet = tmp();
  const quietRec = normalizeRecord({ ...BG_PAYLOAD, scratchpad_dir: bgSpool(quiet, 'babsrioq4', '\n[exited with code 0]\n') });
  assert.strictEqual(quietRec.bgState, 'empty', 'a file holding only the trailer: it really printed nothing');
  assert.strictEqual(quietRec.output, '');

  assert.notStrictEqual(goneRec.bgState, quietRec.bgState,
    'the two cases this ticket exists to separate must not collapse back together');
});

// A background command that FAILED renders as exit 0 without this: the
// PostToolUse branch hardcodes success, and PostToolUseFailure never fires for
// a call the CLI backgrounded.
test('a failed background command reports its real exit code', () => {
  const root = tmp();
  const scratch = bgSpool(root, 'babsrioq4', 'boom\n\n[exited with code 144]\n');
  const rec = normalizeRecord({ ...BG_PAYLOAD, scratchpad_dir: scratch });
  assert.strictEqual(rec.exitCode, 144, 'ENTER: the trailer really was parsed');
  assert.strictEqual(rec.failed, true, 'and the block must draw as a failure');
  assert.strictEqual(rec.output, 'boom');
});

// A missing trailer is evidence of NOTHING, so the field records only whether one
// was seen. It must not be read as "still running": a task killed with the app,
// or one whose dump was cut off, never writes a trailer either and is long dead.
// Real counter-example on this box, a 49,274-byte finished dump ending mid-line:
// .../0898f7eb-61eb-4792-bd26-ca98cb62ca9e/tasks/bkan8wpac.output, 0 trailers.
test('a task file with no exit trailer reports no exit seen, and claims nothing more', () => {
  const root = tmp();
  const scratch = bgSpool(root, 'babsrioq4', 'step 1 done\nstep 2 done\n');
  const rec = normalizeRecord({ ...BG_PAYLOAD, scratchpad_dir: scratch });
  assert.strictEqual(rec.bgExitSeen, false);
  assert.strictEqual(rec.bgState, 'attached');
  assert.strictEqual(rec.output, 'step 1 done\nstep 2 done');
  assert.strictEqual(rec.exitCode, 0, 'no trailer means no exit code was read');
  assert.strictEqual(rec.failed, false, 'and must not be drawn as failed for lacking one');
});

// A long-running build writes an unbounded file. The read is capped like every
// other payload here, and takes the TAIL: the end is where the trailer and the
// newest output are, and a head-truncated build log shows only its banner.
test('an oversized task file is tail-read under the cap, and says so', () => {
  const root = tmp();
  const body = `${'x'.repeat(BG_MAX_BYTES * 2)}TAIL-MARKER\n\n[exited with code 0]\n`;
  const scratch = bgSpool(root, 'babsrioq4', body);
  const rec = normalizeRecord({ ...BG_PAYLOAD, scratchpad_dir: scratch });

  assert.strictEqual(rec.tailed, true, 'ENTER: the file really was over the cap');
  assert.ok(rec.output.length <= BG_MAX_BYTES, 'the attached text is bounded');
  assert.ok(rec.output.endsWith('TAIL-MARKER'),
    'and it is the END of the file, so the newest output survives');
  assert.strictEqual(rec.fullBytes, Buffer.byteLength(body),
    'the true size is reported so the pane can say what fraction is on screen');
});

// The task id is the ONLY caller-influenced part of the derived path, so its
// grammar is what keeps the join inside the tasks dir. Measured over 993
// distinct ids in the transcripts here: every one is 9 chars of [a-z0-9].
test('a task id outside the measured grammar derives no path at all', () => {
  assert.strictEqual(bgOutputPath('/tmp/p/s/scratchpad', '../../../etc/passwd'), null);
  assert.strictEqual(bgOutputPath('/tmp/p/s/scratchpad', 'has/slash'), null);
  assert.strictEqual(bgOutputPath('/tmp/p/s/scratchpad', ''), null);
  assert.strictEqual(bgOutputPath('relative/scratchpad', 'babsrioq4'), null);
  assert.strictEqual(bgOutputPath(undefined, 'babsrioq4'), null,
    'a record lacking scratchpad_dir simply has no file to read');
  assert.strictEqual(bgOutputPath('/tmp/p/s/scratchpad', 'babsrioq4'),
    '/tmp/p/s/tasks/babsrioq4.output');
});

// A payload that DID carry output must not be second-guessed against a file
// that may since have been reused — the response is the authority when non-empty.
test('a backgrounded call that carried output is not re-read from disk', () => {
  const root = tmp();
  const scratch = bgSpool(root, 'babsrioq4', 'FROM-THE-FILE\n[exited with code 0]\n');
  const rec = normalizeRecord({
    ...BG_PAYLOAD,
    scratchpad_dir: scratch,
    tool_response: { ...BG_PAYLOAD.tool_response, stdout: 'FROM-THE-RESPONSE' },
  });
  assert.strictEqual(rec.output, 'FROM-THE-RESPONSE');
  assert.strictEqual(rec.bgState, null, 'no file state, because no file was consulted');
});

// An unreadable file must degrade to `absent`, not throw: this runs in the main
// process inside the console:read handler, and a throw there fails the whole
// pull, losing every OTHER record in the batch along with this one. The reader
// is total by construction, so this pins the real files that could break it
// rather than an injected stub that could not occur.
test('an unreadable task file degrades to absent instead of throwing', () => {
  const root = tmp();
  const scratch = bgSpool(root, 'babsrioq4', null);
  const tasks = path.join(root, 'proj', 'sess', 'tasks');

  fs.mkdirSync(path.join(tasks, 'babsrioq4.output'));
  const dirRec = normalizeRecord({ ...BG_PAYLOAD, scratchpad_dir: scratch });
  assert.strictEqual(dirRec.bgState, 'absent', 'a DIRECTORY where the file should be');
  assert.strictEqual(readBgOutput(path.join(tasks, 'babsrioq4.output')), null);

  assert.strictEqual(readBgOutput(path.join(tasks, 'no-such-file.output')), null,
    'and a plain missing path');
});

// A file that SHRANK between the stat and the read yields 0 bytes at a tail
// offset computed from the old size. Reporting that as an empty read would
// caption a large file "printed nothing", so it degrades to absent instead.
test('a file that shrinks under the tail offset reads as absent, not empty', () => {
  const root = tmp();
  const tasks = path.join(root, 'proj', 'sess', 'tasks');
  const scratch = bgSpool(root, 'babsrioq4', 'x'.repeat(BG_MAX_BYTES * 2));
  const file = path.join(tasks, 'babsrioq4.output');
  const realStat = fs.statSync;
  const big = realStat(file).size;
  fs.writeFileSync(file, 'tiny');
  fs.statSync = (p, ...rest) => {
    const st = realStat(p, ...rest);
    if (String(p) === file) return { ...st, isFile: () => true, size: big };
    return st;
  };
  try {
    assert.strictEqual(readBgOutput(file), null,
      'a read that came back empty from a file the stat called large is not evidence of silence');
  } finally {
    fs.statSync = realStat;
  }
});

// The reader must survive the file it is reading being replaced mid-poll, which
// a live task does constantly. An empty file is a legal read, not a failure, and
// must not be confused with one.
test('a zero-byte task file reads as empty, not as absent', () => {
  const root = tmp();
  const scratch = bgSpool(root, 'babsrioq4', '');
  const rec = normalizeRecord({ ...BG_PAYLOAD, scratchpad_dir: scratch });
  assert.strictEqual(rec.bgState, 'empty', 'ENTER: the zero-byte file really was read');
  assert.strictEqual(rec.bgExitSeen, false, 'no trailer, so nothing is known about completion');
  assert.strictEqual(rec.output, '');
});
