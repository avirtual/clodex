'use strict';
// bash-live.test.js — the FOREGROUND Bash case (t649). Its output file is
// UNLINKED at completion, which is why PostToolUse cannot see it and why the
// live layer exists at all.
//
// The central test here does not assert on a snapshot of a finished file: a
// reader that only ever ran after the writer closed would pass every assertion
// below while streaming nothing, and that is precisely the defect. So the
// streaming test INTERLEAVES a real writer with real reads and asserts that a
// read taken while the file was still open already carried output — the machine
// observes it, nothing self-reports it.
//
// Every fixture drives the REAL fs: fs.watch's event stream is the thing under
// test, and a stubbed watcher would assert only that the fake fires.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  createBashLive, writeObserver, pruneObservers, tasksDirFor, tasksDirFromScratchpad,
  psArgvEncode, argvNeedle,
  OBSERVER_MAX_FILES, TASK_OUTPUT_RE, LIVE_MAX_BYTES, EVENT_QUEUE_MAX, WATCH_SENTINEL,
  RESOLVE_WINDOW_MS,
} = require('../bash-live');
const { pathFor } = require('../clodex-paths');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function tmpRoot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clodex-live-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });
  return dir;
}

// The observer's own view of a call, written the way the PreToolUse hook writes
// it: through writeObserver, from a hook-input JSON string.
function observe(root, seat, { id, command, cwd, sessionId, agentId = null }, opts) {
  const live = pathFor(root, seat, 'bashLive');
  return writeObserver(JSON.stringify({
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_use_id: id,
    tool_input: { command },
    cwd,
    session_id: sessionId,
    ...(agentId ? { agent_id: agentId } : {}),
  }), live, opts);
}

// The zsh preamble the CLI really puts in front of every Bash call, copied from a
// live `ps -o args=` capture on this box (claude 2.1.260). Tests build argv by
// wrapping a command in THIS, so a fixture cannot agree with the matcher by
// construction: the wrapper, the `eval '...'` requoting and the \012 newline
// encoding are the bytes the matcher must survive, and a hand-written
// approximation of them is what let t649's matcher ship green while it could
// never match a multi-line command.
const ZSH_PREAMBLE = "/bin/zsh -c source /Users/b/.claude/shell-snapshots/snapshot-zsh-1788523123004-88g69m.sh 2>/dev/null || true && setopt NO_EXTENDED_GLOB NO_BARE_GLOB_QUAL 2>/dev/null || true && { \\builtin unalias -- 'unsetenv'; \\builtin unset -f -- 'unsetenv'; } >/dev/null 2>&1 || true && ";

function realArgv(command) {
  const quoted = String(command).split("'").join(`'"'"'`);
  return `${ZSH_PREAMBLE}eval '${psArgvEncode(quoted)}' < /dev/null && pwd -P >| /tmp/claude-0866-cwd`;
}

// Stands in for `ps -ax` + `lsof -d 1`: one entry per child shell, its argv as ps
// would PRINT it, and the .output file sitting on its fd 1.
function resolverOf(pairs) {
  return () => pairs.map(([command, file], i) => ({
    pid: String(4000 + i), args: realArgv(command), file,
  }));
}

test('tasksDirFor derives the CLI\'s tasks dir from cwd + session_id', () => {
  const d = tasksDirFor('/Users/x/proj/a b', 'sess-1', { uid: 501, tmpdir: '/tmp' });
  assert.strictEqual(d, '/tmp/claude-501/-Users-x-proj-a-b/sess-1/tasks');
});

test('tasksDirFor refuses a session id that could traverse out of the tmp root', () => {
  // The id is interpolated into a path, so a separator in it would escape the
  // per-session dir. Rejected rather than sanitized: a sanitized id would name
  // a DIFFERENT session's dir and read its output.
  for (const bad of ['../../etc', 'a/b', '', null, 'x'.repeat(129)]) {
    assert.strictEqual(tasksDirFor('/p', bad, { uid: 1, tmpdir: '/tmp' }), null, `rejects ${JSON.stringify(bad)}`);
  }
  assert.ok(tasksDirFor('/p', 'ok-1.2_3', { uid: 1, tmpdir: '/tmp' }), 'ENTER: a legal id still resolves, so the rejections above mean something');
});

test('the observer takes the tasks dir from the payload, NOT from os.tmpdir()', () => {
  // Shipped green while the feature did not work at all. Every fixture passed
  // `tmpdir` through the DI seam, so the derived dir and the fixture's dir agreed
  // by construction; on a real box they do not. TMPDIR is /var/folders/<hash>/T
  // while the CLI writes its tasks under /private/tmp, so the watcher watched a
  // directory that never existed and no foreground output ever streamed.
  // These are the REAL bytes off a live PreToolUse payload, which is why this
  // test may not supply `tmpdir`: the seam is what hid the defect.
  const scratchpad = '/private/tmp/claude-501/-Users-b-proj/5383fbbc/scratchpad';
  const derived = tasksDirFor('/Users/b/proj', '5383fbbc', { uid: 501, tmpdir: '/var/folders/m4/xyz/T' });

  assert.strictEqual(tasksDirFromScratchpad(scratchpad),
    '/private/tmp/claude-501/-Users-b-proj/5383fbbc/tasks');
  assert.notStrictEqual(tasksDirFromScratchpad(scratchpad), derived,
    'ENTER: the two roots must actually DIFFER here, or this test cannot fail');

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clodex-live-real-'));
  try {
    const tasks = path.join(root, 'sess', 'tasks');
    fs.mkdirSync(tasks, { recursive: true });
    fs.writeFileSync(path.join(tasks, 'bAAAAAAAA.output'), 'pre-existing');
    const rec = writeObserver(JSON.stringify({
      tool_name: 'Bash', tool_use_id: 'tu-real', tool_input: { command: 'echo hi' },
      cwd: '/Users/b/proj', session_id: 'sess',
      scratchpad_dir: path.join(root, 'sess', 'scratchpad'),
    }), path.join(root, 'live'), { uid: 501, tmpdir: '/var/folders/m4/xyz/T' });

    assert.strictEqual(rec.tasksDir, tasks,
      'the payload dir must win over the derived one');
    assert.deepStrictEqual(rec.snapshot, ['bAAAAAAAA.output'],
      'and it must actually READ that dir — an unreadable dir silently snapshots []');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a payload with no scratchpad_dir still falls back to the derived dir', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clodex-live-fb-'));
  try {
    const tasks = tasksDirFor('/proj/fb', 'sess', { uid: 7, tmpdir: root });
    fs.mkdirSync(tasks, { recursive: true });
    const rec = writeObserver(JSON.stringify({
      tool_name: 'Bash', tool_use_id: 'tu-fb', tool_input: { command: 'echo hi' },
      cwd: '/proj/fb', session_id: 'sess',
    }), path.join(root, 'live'), { uid: 7, tmpdir: root });
    assert.strictEqual(rec.tasksDir, tasks, 'fallback still resolves when the field is absent');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a relative or empty scratchpad_dir is refused, not joined', () => {
  for (const bad of ['relative/path', '', null, 42]) {
    assert.strictEqual(tasksDirFromScratchpad(bad), null, `refuses ${JSON.stringify(bad)}`);
  }
  assert.ok(tasksDirFromScratchpad('/abs/x/scratchpad'), 'ENTER: an absolute one still resolves');
});

test('writeObserver records the pre-existing files as a snapshot, and ignores non-Bash', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clodex-live-'));
  const cwd = '/proj/one';
  const tasks = tasksDirFor(cwd, 'sess', { uid: 7, tmpdir: root });
  fs.mkdirSync(tasks, { recursive: true });
  fs.writeFileSync(path.join(tasks, 'bAAAAAAAA.output'), 'older call');
  const live = path.join(root, 'live');

  const rec = writeObserver(JSON.stringify({
    tool_name: 'Bash', tool_use_id: 'tu-1', tool_input: { command: 'echo hi' },
    cwd, session_id: 'sess',
  }), live, { uid: 7, tmpdir: root });

  assert.deepStrictEqual(rec.snapshot, ['bAAAAAAAA.output'],
    'the file already there must be in the snapshot, or it is mistaken for this call\'s');
  assert.deepStrictEqual(fs.readdirSync(live), ['tu-1.json']);

  assert.strictEqual(writeObserver(JSON.stringify({
    tool_name: 'Read', tool_use_id: 'tu-2', tool_input: { command: 'x' }, cwd, session_id: 'sess',
  }), live, { uid: 7, tmpdir: root }), null, 'a non-Bash tool writes no observer');
  assert.deepStrictEqual(fs.readdirSync(live), ['tu-1.json'], 'and leaves the dir alone');
  fs.rmSync(root, { recursive: true, force: true });
});

test('a subagent transcript symlink is never adopted as a task file', async (t) => {
  // Measured against claude 2.1.260: a subagent's transcript lands in the SAME
  // tasks dir as `<agent_id>.output`, a SYMLINK, and it is present BEFORE that
  // subagent's first Bash call. Ownership comes from fd 1, so the resolver here
  // NAMES the symlink -- the rejection has to come from the candidate side, and
  // a test whose resolver named only the real file would assert nothing.
  const root = tmpRoot(t);
  const cwd = '/proj/sym';
  const tasks = tasksDirFor(cwd, 'sess', { uid: 7, tmpdir: root });
  fs.mkdirSync(tasks, { recursive: true });
  const target = path.join(root, 'transcript-target');
  fs.writeFileSync(target, 'SUBAGENT-TRANSCRIPT-TEXT\n');
  const link = path.join(tasks, 'agent-99.output');
  fs.symlinkSync(target, link);

  observe(root, 'seat', { id: 'tu-1', command: 'sleep 1', cwd, sessionId: 'sess' },
    { uid: 7, tmpdir: root });

  const real = path.join(tasks, 'bREALFILE.output');
  let offered = link;
  const live = createBashLive({
    REGISTRY_DIR: root,
    resolveOwners: () => [{ pid: '4000', args: realArgv('sleep 1'), file: offered }],
  });
  t.after(() => live.stopAll());
  live.read('seat');
  await sleep(60);
  const rows = live.read('seat');

  assert.strictEqual(rows.length, 1, 'the call keeps a row: an unowned call is shown with its counter');
  assert.strictEqual(rows[0].resolved, false, 'ENTER: it really is unresolved, not resolved-and-empty');
  assert.strictEqual(rows[0].output, '', 'a symlink is not a task file, so nothing was adopted');

  fs.writeFileSync(real, 'REAL-OUTPUT\n');
  offered = real;
  await sleep(120);
  const after = live.read('seat');
  assert.strictEqual(after.length, 1, 'ENTER: the REAL file was adopted, so the symlink assertion above is not vacuous');
  assert.match(after[0].output, /REAL-OUTPUT/);
  assert.doesNotMatch(after[0].output, /SUBAGENT-TRANSCRIPT/, 'and the transcript never reached the pane');
});

test('output is visible WHILE the writer is still appending, not only after it closes', async (t) => {
  // The whole ticket, and the one assertion that can tell this feature from a
  // no-op: reads are taken DURING the write, and at least one of them must
  // already carry a line. A test that read after the writer finished would pass
  // against a reader that streams nothing at all.
  const root = tmpRoot(t);
  const cwd = '/proj/stream';
  const tasks = tasksDirFor(cwd, 'sess', { uid: 7, tmpdir: root });
  fs.mkdirSync(tasks, { recursive: true });
  observe(root, 'seat', { id: 'tu-1', command: 'emit lines', cwd, sessionId: 'sess' },
    { uid: 7, tmpdir: root });

  const file = path.join(tasks, 'bSTREAM01.output');
  const live = createBashLive({
    REGISTRY_DIR: root,
    resolveOwners: resolverOf([['emit lines', file]]),
  });
  t.after(() => live.stopAll());
  live.read('seat');
  const fd = fs.openSync(file, 'a');
  const readsDuringWrite = [];
  try {
    for (let i = 1; i <= 4; i++) {
      fs.writeSync(fd, `line ${i}\n`);
      await sleep(80);
      readsDuringWrite.push(live.read('seat'));
    }
    // Asserted while the fd is STILL OPEN and the file still on disk: this is
    // the state PostToolUse can never observe.
    assert.ok(fs.existsSync(file), 'ENTER: the file is still present and open, which is the state under test');
    const withOutput = readsDuringWrite.filter((r) => r.length === 1 && r[0].output.includes('line 1'));
    assert.ok(withOutput.length >= 3,
      `expected most mid-write reads to carry output, got ${withOutput.length} of ${readsDuringWrite.length}`);
    const first = withOutput[0];
    assert.strictEqual(first[0].finished, false, 'a call whose file is still open is not finished');
    assert.strictEqual(first[0].command, 'emit lines');
  } finally {
    fs.closeSync(fd);
  }

  // Growth is monotone across the reads, which is what "streaming" means as
  // opposed to a single late snapshot repeated.
  const lens = readsDuringWrite.map((r) => (r[0] ? r[0].output.length : 0));
  assert.ok(lens[lens.length - 1] > lens[0],
    `output must GROW across reads, got ${lens.join(' -> ')}`);
  assert.match(readsDuringWrite[readsDuringWrite.length - 1][0].output, /line 4/);
});

test('the DELETE of the file finalizes the row, and the last read keeps what it had', async (t) => {
  const root = tmpRoot(t);
  const cwd = '/proj/fin';
  const tasks = tasksDirFor(cwd, 'sess', { uid: 7, tmpdir: root });
  fs.mkdirSync(tasks, { recursive: true });
  observe(root, 'seat', { id: 'tu-1', command: 'run', cwd, sessionId: 'sess' }, { uid: 7, tmpdir: root });

  const file = path.join(tasks, 'bFINAL001.output');
  const live = createBashLive({
    REGISTRY_DIR: root,
    resolveOwners: resolverOf([['run', file]]),
  });
  t.after(() => live.stopAll());
  live.read('seat');
  fs.writeFileSync(file, 'PARTIAL\n');
  await sleep(120);
  assert.strictEqual(live.read('seat')[0].finished, false, 'ENTER: it was live before the unlink');

  fs.unlinkSync(file);
  await sleep(120);
  const rows = live.read('seat');
  assert.strictEqual(rows.length, 1, 'the row survives its file for the finalize grace');
  assert.strictEqual(rows[0].finished, true, 'and is marked finished by the delete');
  assert.match(rows[0].output, /PARTIAL/, 'keeping the text it had read');
});

test('two concurrent calls are told apart by argv, each getting ITS OWN file', async (t) => {
  const root = tmpRoot(t);
  const cwd = '/proj/two';
  const tasks = tasksDirFor(cwd, 'sess', { uid: 7, tmpdir: root });
  fs.mkdirSync(tasks, { recursive: true });

  // Both are MULTI-LINE, which is the case t649 could never resolve, and both
  // are in flight at once with neither file excluded by anything: the argv
  // needle is the only thing that can separate them.
  const cmdA = 'for f in *.js; do\n  echo "$f"\ndone';
  const cmdB = 'while read l; do\n  printf "%s" "$l"\ndone';
  observe(root, 'seat', { id: 'tu-A', command: cmdA, cwd, sessionId: 'sess' }, { uid: 7, tmpdir: root });
  observe(root, 'seat', { id: 'tu-B', command: cmdB, cwd, sessionId: 'sess' }, { uid: 7, tmpdir: root });
  const fileA = path.join(tasks, 'bAAAA0001.output');
  const fileB = path.join(tasks, 'bBBBB0001.output');
  fs.writeFileSync(fileA, 'A-OUT\n');
  fs.writeFileSync(fileB, 'B-OUT\n');

  const live = createBashLive({
    REGISTRY_DIR: root,
    resolveOwners: resolverOf([[cmdA, fileA], [cmdB, fileB]]),
  });
  t.after(() => live.stopAll());
  live.read('seat');
  await sleep(150);
  const rows = live.read('seat');

  const byCmd = Object.fromEntries(rows.map((r) => [r.command, r.output]));
  assert.deepStrictEqual(Object.keys(byCmd).sort(), [cmdA, cmdB].sort(),
    'ENTER: both calls were painted, so the pairing below is not asserted over one row');
  assert.match(byCmd[cmdA], /A-OUT/, 'A got the file whose holder argv carried A');
  assert.match(byCmd[cmdB], /B-OUT/, 'and B got its own');
});

test('two IDENTICAL concurrent commands resolve to NOTHING rather than guessing', async (t) => {
  // Constraint 1, and the case the mechanism cannot decide: two processes carry
  // the same needle, so neither file can be attributed. Misattributing A's output
  // under B is worse than showing none, so the rows keep their command and their
  // elapsed counter and stay empty.
  const root = tmpRoot(t);
  const cwd = '/proj/same';
  const tasks = tasksDirFor(cwd, 'sess', { uid: 7, tmpdir: root });
  fs.mkdirSync(tasks, { recursive: true });

  const same = 'npm test';
  observe(root, 'seat', { id: 'tu-A', command: same, cwd, sessionId: 'sess' }, { uid: 7, tmpdir: root });
  observe(root, 'seat', { id: 'tu-B', command: same, cwd, sessionId: 'sess' }, { uid: 7, tmpdir: root });
  const fileA = path.join(tasks, 'bSAME0001.output');
  const fileB = path.join(tasks, 'bSAME0002.output');
  fs.writeFileSync(fileA, 'FIRST-OUT\n');
  fs.writeFileSync(fileB, 'SECOND-OUT\n');

  const live = createBashLive({
    REGISTRY_DIR: root,
    resolveOwners: resolverOf([[same, fileA], [same, fileB]]),
  });
  t.after(() => live.stopAll());
  live.read('seat');
  await sleep(150);
  const rows = live.read('seat');

  assert.strictEqual(rows.length, 2, 'ENTER: both calls still have rows, so the emptiness below is a refusal and not an absence');
  for (const r of rows) {
    assert.strictEqual(r.command, same);
    assert.strictEqual(r.output, '', 'an undecidable owner yields NO output rather than a guess');
    assert.strictEqual(r.resolved, false);
    assert.strictEqual(typeof r.elapsedMs, 'number', 'and the row still carries the elapsed counter shown in its place');
  }
});

test('an unresolvable call stops costing ps+lsof once its window closes', async (t) => {
  // The cost bound. An observer whose process is gone can never resolve, and at
  // a 500ms cadence a resolver left running against it is two execs a second for
  // as long as the observer file survives.
  const root = tmpRoot(t);
  const cwd = '/proj/failprobe';
  const tasks = tasksDirFor(cwd, 'sess', { uid: 7, tmpdir: root });
  fs.mkdirSync(tasks, { recursive: true });

  let clock = 1_000_000;
  observe(root, 'seat', { id: 'tu-A', command: 'alpha', cwd, sessionId: 'sess' },
    { uid: 7, tmpdir: root, now: () => clock });
  fs.writeFileSync(path.join(tasks, 'bFAIL0001.output'), 'X\n');
  let calls = 0;
  const live = createBashLive({
    REGISTRY_DIR: root,
    now: () => clock,
    // Nothing on the box carries this call's needle: the process already exited.
    resolveOwners: () => { calls++; return [{ pid: '999', args: '/bin/zsh -c something-else', file: '/tmp/other.output' }]; },
  });
  t.after(() => live.stopAll());
  live.read('seat');
  await sleep(120);
  live.read('seat');
  const during = calls;
  assert.ok(during > 0, 'ENTER: the resolver really was consulted while the window was open');

  const row = live.read('seat')[0];
  assert.strictEqual(row.resolved, false, 'ENTER: it really is unresolved, which is the state that must expire');
  assert.strictEqual(row.output, '', 'and it never adopted the unrelated file');

  clock += RESOLVE_WINDOW_MS + 1000;
  const after = live.read('seat');
  const settled = calls;
  for (let i = 0; i < 10; i++) live.read('seat');

  assert.deepStrictEqual(after, [], 'past its window the phantom row is dropped rather than counting up forever');
  assert.strictEqual(calls, settled,
    `and 10 further reads must add no resolver calls, got ${calls - settled}`);
});

test('the watcher holds no fd when nothing is in flight, and releases them when reads stop', async (t) => {
  // The design's premise, stated as a number the test can check: idle cost is
  // ZERO watched dirs, versus the 56ms-per-tick lsof table the polling design
  // would have paid forever.
  const root = tmpRoot(t);
  const cwd = '/proj/idle';
  const tasks = tasksDirFor(cwd, 'sess', { uid: 7, tmpdir: root });
  fs.mkdirSync(tasks, { recursive: true });

  let clock = 1_000_000;
  const live = createBashLive({ REGISTRY_DIR: root, now: () => clock });
  t.after(() => live.stopAll());

  assert.deepStrictEqual(live.read('seat'), []);
  assert.strictEqual(live.watchedDirCount(), 0, 'no observer, no watch: the idle seat costs nothing');

  observe(root, 'seat', { id: 'tu-1', command: 'x', cwd, sessionId: 'sess' }, { uid: 7, tmpdir: root });
  live.read('seat');
  assert.strictEqual(live.watchedDirCount(), 1, 'ENTER: an in-flight call really did open one watch');

  clock += 60_000;
  live.read('other-seat');
  assert.strictEqual(live.watchedDirCount(), 0,
    'a seat nothing has read for IDLE_REAP_MS releases its watch rather than holding a kqueue fd forever');
});

test('a stale observer whose file never appeared is dropped, not kept as a phantom row', async (t) => {
  const root = tmpRoot(t);
  const cwd = '/proj/stale';
  const tasks = tasksDirFor(cwd, 'sess', { uid: 7, tmpdir: root });
  fs.mkdirSync(tasks, { recursive: true });

  let clock = 1_000_000;
  const live = createBashLive({ REGISTRY_DIR: root, now: () => clock });
  t.after(() => live.stopAll());
  observe(root, 'seat', { id: 'tu-1', command: 'x', cwd, sessionId: 'sess' },
    { uid: 7, tmpdir: root, now: () => clock });

  const pending = live.read('seat');
  assert.strictEqual(pending.length, 1, 'the call is shown while it waits — running blind is the bug being fixed');
  assert.strictEqual(pending[0].output, '', 'with no output, since no file has been attributed to it');
  assert.strictEqual(pending[0].resolved, false);
  const liveDir = pathFor(root, 'seat', 'bashLive');
  // `.watching` is the hook's gate, written by read() and removed by stop(). It
  // is not an observer and must survive the reaping that removes them: deleting
  // it here would silently switch the hook off for a seat still being watched.
  const observers = () => fs.readdirSync(liveDir).filter((n) => n !== WATCH_SENTINEL);
  assert.deepStrictEqual(observers(), ['tu-1.json'], 'ENTER: the observer is on disk to be aged out');

  clock += 7 * 60 * 60 * 1000;
  live.read('seat');
  assert.deepStrictEqual(observers(), [],
    'an observer whose call left no trace is reaped — a crashed CLI must not leak one file per Bash call');
  assert.ok(fs.existsSync(path.join(liveDir, WATCH_SENTINEL)),
    'and the gate survives the reap, or the next Bash call goes unobserved');
});

test('pruneObservers bounds the dir, keeping the newest', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clodex-live-'));
  const live = path.join(root, 'live');
  fs.mkdirSync(live, { recursive: true });
  const total = OBSERVER_MAX_FILES + 10;
  // All well inside OBSERVER_MAX_AGE_MS of the `now` below: this test is about
  // the COUNT cap, and ages that tripped the age cap would empty the dir by the
  // other rule and pass every assertion here for the wrong reason.
  const base = Date.now();
  for (let i = 0; i < total; i++) {
    const f = path.join(live, `id-${String(i).padStart(3, '0')}.json`);
    fs.writeFileSync(f, '{}');
    const when = new Date(base + i * 1000);
    fs.utimesSync(f, when, when);
  }
  assert.strictEqual(fs.readdirSync(live).length, total, 'ENTER: the dir really was over the cap before the prune');

  pruneObservers(live, { now: () => base + total * 1000 });
  const left = fs.readdirSync(live).sort();
  assert.strictEqual(left.length, OBSERVER_MAX_FILES);
  assert.strictEqual(left[left.length - 1], `id-${String(total - 1).padStart(3, '0')}.json`,
    'the NEWEST survives — dropping the newest would delete the call currently running');
});

test('the argv encoder reproduces what ps PRINTS, byte for byte', () => {
  // Measured against a crafted argv on macOS with xxd, not assumed: ps does not
  // print argv raw, it escapes. \n and \t become the four-character sequences
  // \\012 and \\011, other control bytes become caret notation. A matcher that
  // instead NORMALIZES both sides (t649 collapsed whitespace) can never match a
  // multi-line command, and agent Bash calls are routinely multi-line.
  assert.strictEqual(psArgvEncode('X\nY\tZ\rW\x01V'), 'X\\012Y\\011Z^MW^AV');
  assert.strictEqual(psArgvEncode('plain text'), 'plain text');

  // Backslash is NOT escaped, which is why this direction is the only sound one:
  // `a\\012b` and a real newline both print as the same bytes, so DECODING ps
  // output is ambiguous while encoding the known command is exact.
  assert.strictEqual(psArgvEncode('a\\012b'), 'a\\012b');
  assert.strictEqual(psArgvEncode('a\nb'), 'a\\012b');
});

test('the needle matches a REAL argv carrying both a newline and a single quote', () => {
  // The case t649 could not match at all. Bytes below are a live `ps -o args=`
  // capture from this box (claude 2.1.260), not a hand-written approximation --
  // an approximation is what made the broken matcher look tested.
  const command = 'ps -p $$ -o args= > /tmp/t650argv3.txt\necho \'it\'"\'"\'s\'\necho "done"';
  const REAL_ARGV = "/bin/zsh -c source /Users/bogdan/.claude/shell-snapshots/snapshot-zsh-1788523123004-88g69m.sh 2>/dev/null || true && setopt NO_EXTENDED_GLOB NO_BARE_GLOB_QUAL 2>/dev/null || true && { \\builtin unalias -- 'unsetenv'; \\builtin unset -f -- 'unsetenv'; } >/dev/null 2>&1 || true && eval 'ps -p $$ -o args= > /tmp/t650argv3.txt\\012echo '\"'\"'it'\"'\"'\"'\"'\"'\"'\"'\"'s'\"'\"'\\012echo \"done\"' < /dev/null && pwd -P >| /tmp/claude-e063-cwd";

  assert.ok(command.includes('\n') && command.includes("'"),
    'ENTER: the command really does carry both a newline and a quote, or this pins nothing');
  assert.ok(REAL_ARGV.includes('\\012'),
    'ENTER: the captured argv really is in ps ESCAPED form, not raw');
  assert.ok(REAL_ARGV.includes(argvNeedle(command)),
    'the needle must be found in the real bytes — this is the whole ownership mechanism');
});

test('a needle is refused for an empty command rather than matching everything', () => {
  // A needle of `eval ''` would be a substring of nothing useful, but an empty
  // or absent command must not produce a needle at all: a matcher that returns
  // a match for every process assigns output to the wrong call, which
  // constraint 1 ranks as worse than showing none.
  for (const bad of ['', null, undefined]) assert.strictEqual(argvNeedle(bad), null);
  assert.ok(argvNeedle('echo hi'), 'ENTER: a real command still yields a needle');
});

test('TASK_OUTPUT_RE admits the CLI\'s ids and rejects a traversal', () => {
  assert.ok(TASK_OUTPUT_RE.test('bkan8wpac.output'), 'ENTER: a real observed id matches, so the rejections mean something');
  for (const bad of ['../x.output', 'a/b.output', '.output', 'x.output.json', 'x.txt']) {
    assert.ok(!TASK_OUTPUT_RE.test(bad), `must reject ${bad}`);
  }
});

// ─── Round-1 rework: the paths the tests above structurally cannot reach ────

test('a seat nobody reads again releases its watch WITHOUT another seat being read', async (t) => {
  // The leak the first round shipped. `reap` ran only from `read`, so closing
  // the tab — which ends all reads — left the last seat's kqueue fd open for the
  // life of the process. The existing idle test cannot catch it: it reaps by
  // reading a DIFFERENT seat, which is the one path a closed tab never takes.
  // So this drives the real shape: read once, then never read anything again.
  const root = tmpRoot(t);
  const cwd = '/proj/closed';
  const tasks = tasksDirFor(cwd, 'sess', { uid: 7, tmpdir: root });
  fs.mkdirSync(tasks, { recursive: true });
  observe(root, 'seat', { id: 'tu-1', command: 'x', cwd, sessionId: 'sess' }, { uid: 7, tmpdir: root });

  let clock = 1_000_000;
  let sweep = null;
  const live = createBashLive({
    REGISTRY_DIR: root,
    now: () => clock,
    // Captured rather than timed, so the test drives the sweep instead of
    // sleeping for it — and so a version with NO sweep at all fails here
    // rather than passing slowly.
    setInterval: (fn) => { sweep = fn; return { unref() {} }; },
    clearInterval: () => { sweep = null; },
  });
  t.after(() => live.stopAll());

  live.read('seat');
  assert.strictEqual(live.watchedDirCount(), 1, 'ENTER: the in-flight call opened a watch to be released');
  assert.ok(sweep, 'a watch must arm a self-driving sweep — nothing else will run once the tab closes');

  // The tab closes here. No further read() of any seat, ever.
  clock += 60_000;
  sweep();

  assert.strictEqual(live.watchedDirCount(), 0,
    'the watch is released with no read to trigger it — otherwise the fd is held for the process lifetime');
});

test('the sweep is disarmed once no seat is left, and re-armed by the next call', async (t) => {
  // The other half: a timer that outlives its last SEAT is the same leak in a
  // cheaper currency, and an unref'd interval running forever is invisible.
  // Keyed to the seat, not the watch — a watch-keyed condition stopped the
  // sweep in the gap between two Bash calls, which is the round-2 defect.
  const root = tmpRoot(t);
  const cwd = '/proj/sweep';
  const tasks = tasksDirFor(cwd, 'sess', { uid: 7, tmpdir: root });
  fs.mkdirSync(tasks, { recursive: true });
  observe(root, 'seat', { id: 'tu-1', command: 'x', cwd, sessionId: 'sess' }, { uid: 7, tmpdir: root });

  let clock = 1_000_000;
  let armed = 0;
  let sweep = null;
  const live = createBashLive({
    REGISTRY_DIR: root,
    now: () => clock,
    setInterval: (fn) => { armed++; sweep = fn; return { unref() {} }; },
    clearInterval: () => { sweep = null; },
  });
  t.after(() => live.stopAll());

  live.read('seat');
  assert.strictEqual(armed, 1, 'ENTER: the sweep armed once for the first watch');

  clock += 60_000;
  sweep();
  assert.strictEqual(live.watchedDirCount(), 0);
  assert.strictEqual(live.seatCount(), 0, 'ENTER: the seat itself is gone, which is what the sweep keys on');
  assert.strictEqual(sweep, null, 'with no seat left the sweep stops rather than ticking forever');

  observe(root, 'seat2', { id: 'tu-2', command: 'y', cwd, sessionId: 'sess' }, { uid: 7, tmpdir: root });
  live.read('seat2');
  assert.strictEqual(armed, 2, 'and a later call re-arms it — disarming must not be permanent');
});

test('a burst of events cannot grow the queue without bound', async (t) => {
  // The watch callback pushed one string per event into an array drained only by
  // a read. With the tab closed nothing drains it, so a command emitting a line
  // a second appends forever. The overflow collapses to a single full-rescan
  // marker, which is strictly more correct than the names it replaces.
  const root = tmpRoot(t);
  const cwd = '/proj/burst';
  const tasks = tasksDirFor(cwd, 'sess', { uid: 7, tmpdir: root });
  fs.mkdirSync(tasks, { recursive: true });
  observe(root, 'seat', { id: 'tu-1', command: 'noisy', cwd, sessionId: 'sess' }, { uid: 7, tmpdir: root });

  const file = path.join(tasks, 'bBURST001.output');
  let fire = null;
  const live = createBashLive({
    REGISTRY_DIR: root,
    watch: (dir, cb) => { fire = cb; return { close() {} }; },
    resolveOwners: resolverOf([['noisy', file]]),
  });
  t.after(() => live.stopAll());
  live.read('seat');
  assert.ok(fire, 'ENTER: the watch was opened, so the burst below reaches the real callback');

  for (let i = 0; i < EVENT_QUEUE_MAX * 4; i++) fire('change', 'bBURST001.output');

  // The claim is about the QUEUE, not about the output: an unbounded push grows
  // one string per event for as long as the command runs, and asserting only
  // that the output still resolves passes either way.
  assert.ok(live.pendingEventCount() <= EVENT_QUEUE_MAX,
    `the undrained queue must stay bounded, got ${live.pendingEventCount()} after ${EVENT_QUEUE_MAX * 4} events`);

  fs.writeFileSync(file, 'BURST-OUTPUT\n');
  const rows = live.read('seat');
  assert.strictEqual(rows.length, 1, 'the overflow marker still resolves the call by rescan');
  assert.match(rows[0].output, /BURST-OUTPUT/, 'so collapsing the queue loses no output');
});

test('a file that grew past the cap between reads is read in bounded memory', async (t) => {
  // `Buffer.alloc(size - offset)` with no clamp let the agent's own command pick
  // the allocation size in the MAIN process: 40MB between two ticks meant a 40MB
  // buffer and a 40MB string, trimmed to LIVE_MAX_BYTES only afterwards. The
  // sibling reader (bash-console.js) already read from the tail under a cap.
  const root = tmpRoot(t);
  const cwd = '/proj/huge';
  const tasks = tasksDirFor(cwd, 'sess', { uid: 7, tmpdir: root });
  fs.mkdirSync(tasks, { recursive: true });
  observe(root, 'seat', { id: 'tu-1', command: 'flood', cwd, sessionId: 'sess' }, { uid: 7, tmpdir: root });

  const hugeFile = path.join(tasks, 'bHUGE0001.output');
  const live = createBashLive({
    REGISTRY_DIR: root,
    resolveOwners: resolverOf([['flood', hugeFile]]),
  });
  t.after(() => live.stopAll());
  live.read('seat');

  const huge = LIVE_MAX_BYTES * 8;
  const body = `${'a'.repeat(huge)}\nTAIL-MARKER\n`;
  fs.writeFileSync(hugeFile, body);

  const allocs = [];
  const realAlloc = Buffer.alloc;
  Buffer.alloc = (n, ...rest) => { allocs.push(n); return realAlloc.call(Buffer, n, ...rest); };
  let rows;
  try {
    await sleep(150);
    rows = live.read('seat');
  } finally {
    Buffer.alloc = realAlloc;
  }

  assert.strictEqual(rows.length, 1, 'ENTER: the flooding call was read at all');
  assert.ok(allocs.length > 0, 'ENTER: the read really did allocate, so the ceiling below is measured');
  const biggest = Math.max(...allocs);
  assert.ok(biggest <= LIVE_MAX_BYTES,
    `no single read may exceed LIVE_MAX_BYTES; largest allocation was ${biggest}`);
  assert.match(rows[0].output, /TAIL-MARKER/,
    'and it keeps the END of the file — where a build\'s errors and its exit line are');
  assert.strictEqual(rows[0].tailed, true, 'the row says it is showing a tail rather than the whole output');
});

test('a seat with no call in flight still disarms the hook once nobody reads it', async (t) => {
  // "No Bash call in flight" is the state a tab sits in almost all the time, and
  // it takes read()'s early return — which drops the watch. With the sweep's
  // liveness keyed to WATCHES, the timer was then cleared while the seat was
  // still armed on disk, so closing the tab left `.watching` for the process
  // lifetime and every later Bash call paid the interpreter spawn NIT-1 removed.
  //
  // The two sweep tests above cannot see this: both drive a seat that HAS a
  // watch. The stale-observer test asserts the sentinel SURVIVES a reap, never
  // that it is eventually removed. So the liveness condition has to be the seat,
  // not the watch.
  const root = tmpRoot(t);
  let clock = 1_000_000;
  let sweep = null;
  const live = createBashLive({
    REGISTRY_DIR: root,
    now: () => clock,
    setInterval: (fn) => { sweep = fn; return { unref() {} }; },
    clearInterval: () => { sweep = null; },
  });
  t.after(() => live.stopAll());

  // No observer is ever written: this seat has no Bash call in flight at all.
  live.read('seat');
  const sentinel = path.join(pathFor(root, 'seat', 'bashLive'), WATCH_SENTINEL);
  assert.ok(fs.existsSync(sentinel),
    'ENTER: reading the seat armed the hook, so there is something to disarm');
  assert.strictEqual(live.watchedDirCount(), 0,
    'ENTER: and it did so with NO watch open, which is the path under test');
  assert.ok(sweep, 'an armed seat must arm the sweep even with no watch — nothing else will disarm it');

  clock += 60_000;
  sweep();

  assert.ok(!fs.existsSync(sentinel),
    'the hook is disarmed once nobody reads the seat — otherwise every later Bash call pays the spawn');
  assert.strictEqual(live.seatCount(), 0, 'and the seat itself is released');
});
