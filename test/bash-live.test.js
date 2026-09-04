'use strict';
// bash-live.test.js — the FOREGROUND Bash case. Its output file is
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
  psArgvEncode, argvNeedle, defaultResolveOwners,
  OBSERVER_MAX_FILES, TASK_OUTPUT_RE, LIVE_MAX_BYTES, EVENT_QUEUE_MAX, WATCH_SENTINEL,
  RESOLVE_WINDOW_MS,
} = require('../bash-live');
const { pathFor } = require('../clodex-paths');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function tmpRoot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clodex-live-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });
  // RESOLVED, because on macOS os.tmpdir() is itself a symlink (/var -> /private/var)
  // and a fixture keyed on the unresolved form cannot see a defect that is exactly
  // about the two namespaces disagreeing.
  return fs.realpathSync(dir);
}

// The observer's own view of a call, written the way the PreToolUse hook writes
// it: through writeObserver, from a hook-input JSON string.
function observe(root, seat, { id, command, cwd, sessionId, agentId = null, scratchpadDir = null }, opts) {
  const live = pathFor(root, seat, 'bashLive');
  return writeObserver(JSON.stringify({
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_use_id: id,
    tool_input: { command },
    cwd,
    session_id: sessionId,
    ...(agentId ? { agent_id: agentId } : {}),
    ...(scratchpadDir ? { scratchpad_dir: scratchpadDir } : {}),
  }), live, opts);
}

// The zsh preamble the CLI really puts in front of every Bash call, copied from a
// live `ps -o args=` capture on this box (claude 2.1.260). Tests build argv by
// wrapping a command in THIS, so a fixture cannot agree with the matcher by
// construction: the wrapper, the `eval '...'` requoting and the \012 newline
// encoding are the bytes the matcher must survive, and a hand-written
// approximation of them is what let an earlier matcher ship green while it
// could never match a multi-line command.
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

test('writeObserver records the call, and ignores non-Bash', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clodex-live-'));
  const cwd = '/proj/one';
  const tasks = tasksDirFor(cwd, 'sess', { uid: 7, tmpdir: root });
  fs.mkdirSync(tasks, { recursive: true });
  const live = path.join(root, 'live');

  const rec = writeObserver(JSON.stringify({
    tool_name: 'Bash', tool_use_id: 'tu-1', tool_input: { command: 'echo hi' },
    cwd, session_id: 'sess',
  }), live, { uid: 7, tmpdir: root });

  assert.strictEqual(rec.command, 'echo hi', 'the command is what ownership is later resolved by');
  assert.strictEqual(rec.tasksDir, tasks);
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

test('the resolver keeps lsof output when lsof exits NONZERO', () => {
  // Measured, and it made the whole feature inert once: `lsof -p <list>` exits 1
  // if ANY pid in the list has already gone, which is the normal case here --
  // between the ps and the lsof, other short calls on an ~800-process box come
  // and go. execFileSync turns that status into a throw, and a catch that
  // returned [] discarded the pids that DID resolve, on every single read.
  //
  // Drives the REAL defaultResolveOwners through a stubbed exec, so the parsing
  // under test is the shipped parsing rather than a copy of it in this fixture.
  const outFile = '/private/tmp/claude-501/-Users-b-proj/sess/tasks/bLIVE0001.output';
  const needle = argvNeedle('counter');
  const exec = (bin) => {
    if (bin === 'ps') return `  4321 ${realArgv('counter')}\n  4322 /usr/sbin/unrelated\n`;
    throw Object.assign(new Error('Command failed: lsof'), {
      status: 1,
      stdout: `p4321\nf1\nn${outFile}\n`,
    });
  };

  const rows = defaultResolveOwners([needle], { exec });
  assert.deepStrictEqual(rows.map((r) => [r.pid, r.file]), [['4321', outFile]],
    'a nonzero lsof status must not discard the pids that DID resolve');
  assert.ok(rows[0].args.includes(needle), 'and each row carries the argv the needle matched');
});

test('the resolver narrows to matching pids BEFORE spending an lsof', () => {
  // lsof's cost scales with the pids handed to it, and a box runs ~800 processes
  // while a Bash call in flight is one. Narrowing on the ps output first is what
  // keeps the probe affordable at a 500ms cadence.
  let askedFor = null;
  const exec = (bin, args) => {
    if (bin === 'ps') return `  10 ${realArgv('wanted-cmd')}\n  11 ${realArgv('other-cmd')}\n  12 /sbin/launchd\n`;
    askedFor = args[args.indexOf('-p') + 1];
    return 'p10\nf1\nn/tmp/tasks/bW.output\n';
  };

  const rows = defaultResolveOwners([argvNeedle('wanted-cmd')], { exec });
  assert.strictEqual(askedFor, '10', 'only the pid whose argv carried the needle is handed to lsof');
  assert.deepStrictEqual(rows.map((r) => r.pid), ['10'], 'ENTER: and it did resolve, so the narrowing is not just refusing');

  assert.deepStrictEqual(defaultResolveOwners([], { exec }), [],
    'with no needles there is nothing to own, so neither command is worth running');
});

test('two concurrent calls are told apart by argv, each getting ITS OWN file', async (t) => {
  const root = tmpRoot(t);
  const cwd = '/proj/two';
  const tasks = tasksDirFor(cwd, 'sess', { uid: 7, tmpdir: root });
  fs.mkdirSync(tasks, { recursive: true });

  // Both are MULTI-LINE, the case a whitespace-collapsing matcher can never
  // resolve, and both
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

// ---------------------------------------------------------------------------
// IDENTICAL command text (the "subagent fan-out" case).
//
// The test directly above is the pin this whole block exists to complement, and
// it is BLIND to what follows: its two calls carry DISTINCT command text, so
// each argv needle matches exactly one process and the file dedupe answers on
// its own. Reach the same resolver with two calls whose text is byte-identical
// -- which is what N subagents running the same command produce -- and one
// needle matches BOTH processes, the file set has size 2, and master's
// `files.size !== 1` refused both for the whole run. Measured live: two agents
// on identical loops, resolved=false for their entire life, while the same
// command run solo streamed 73 ticks.
//
// So a needle group is resolved as a GROUP: K observers, K distinct free files,
// paired by `startedAt` ascending against file creation time ascending. The
// fixtures below hand the resolver its processes in an order that is neither
// the birthtime order NOR the lexicographic order of the file paths, so an
// implementation that paired by iteration order or by name would hand each row
// the other row's output and fail on the content assertion, not merely on a
// count.

// Two observers a known distance apart in `startedAt`, so the ordering the
// pairing keys on is the fixture's and not the clock's. Real wall-clock times
// (offset from now), because an observer older than RESOLVE_WINDOW_MS is
// dropped before assignment and would vacuum out every assertion downstream.
function observeSeries(root, cwd, ids, command, uidOpts) {
  const base = Date.now() - 1000;
  ids.forEach((id, i) => {
    observe(root, 'seat', { id, command, cwd, sessionId: 'sess' },
      { ...uidOpts, now: () => base + i * 10 });
  });
}

async function birthOrdered(files) {
  for (const [p, body] of files) {
    fs.writeFileSync(p, body);
    await sleep(12);
  }
  const times = files.map(([p]) => fs.statSync(p).birthtimeMs);
  for (let i = 1; i < times.length; i += 1) {
    assert.ok(times[i - 1] < times[i],
      'ENTER: the fixture files must really be born in order, or the pairing below is untested');
  }
}

test('twins: two in-flight calls with IDENTICAL command text each get the RIGHT file', async (t) => {
  const root = tmpRoot(t);
  const cwd = '/proj/twins';
  const tasks = tasksDirFor(cwd, 'sess', { uid: 7, tmpdir: root });
  fs.mkdirSync(tasks, { recursive: true });

  const cmd = 'npm test -- --reporter=dot';
  // 'tu-zz' starts FIRST: id order is the reverse of startedAt order, so a
  // pairing that fell back to the observer id would swap the two rows.
  observeSeries(root, cwd, ['tu-zz', 'tu-aa'], cmd, { uid: 7, tmpdir: root });

  // Born first -> belongs to the observer that started first. Named LAST
  // alphabetically, so name order disagrees with birth order too.
  const early = path.join(tasks, 'bZZZZ0001.output');
  const late = path.join(tasks, 'bAAAA0001.output');
  await birthOrdered([[early, 'EARLY-OUT\n'], [late, 'LATE-OUT\n']]);

  const live = createBashLive({
    REGISTRY_DIR: root,
    // Handed back late-file-first: the resolver's own order is a third order
    // that disagrees with the answer.
    resolveOwners: () => [
      { pid: '7002', args: realArgv(cmd), file: late },
      { pid: '7001', args: realArgv(cmd), file: early },
    ],
  });
  t.after(() => live.stopAll());
  live.read('seat');
  await sleep(150);
  const rows = live.read('seat');

  const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
  assert.deepStrictEqual(Object.keys(byId).sort(), ['tu-aa', 'tu-zz'],
    'ENTER: BOTH rows were painted, so the two assertions below are not one row twice');
  assert.strictEqual(byId['tu-zz'].resolved, true, 'the call that started first resolved');
  assert.strictEqual(byId['tu-aa'].resolved, true, 'and so did the one that started second');
  assert.match(byId['tu-zz'].output, /EARLY-OUT/, 'the earlier call got the file born first');
  assert.match(byId['tu-aa'].output, /LATE-OUT/, 'and the later call got the file born second');
});

test('triplets: the identical-text pairing is general, not a two-case special', async (t) => {
  const root = tmpRoot(t);
  const cwd = '/proj/triplets';
  const tasks = tasksDirFor(cwd, 'sess', { uid: 7, tmpdir: root });
  fs.mkdirSync(tasks, { recursive: true });

  const cmd = 'rg --json TODO';
  observeSeries(root, cwd, ['tu-1st', 'tu-2nd', 'tu-3rd'], cmd, { uid: 7, tmpdir: root });

  const f1 = path.join(tasks, 'bMMMM0001.output');
  const f2 = path.join(tasks, 'bAAAA0001.output');
  const f3 = path.join(tasks, 'bZZZZ0001.output');
  await birthOrdered([[f1, 'OUT-1\n'], [f2, 'OUT-2\n'], [f3, 'OUT-3\n']]);

  const live = createBashLive({
    REGISTRY_DIR: root,
    resolveOwners: () => [
      { pid: '8003', args: realArgv(cmd), file: f3 },
      { pid: '8001', args: realArgv(cmd), file: f1 },
      { pid: '8002', args: realArgv(cmd), file: f2 },
    ],
  });
  t.after(() => live.stopAll());
  live.read('seat');
  await sleep(150);
  const rows = live.read('seat');

  const byId = Object.fromEntries(rows.map((r) => [r.id, r.output]));
  assert.deepStrictEqual(Object.keys(byId).sort(), ['tu-1st', 'tu-2nd', 'tu-3rd'],
    'ENTER: all three rows were painted');
  assert.match(byId['tu-1st'], /OUT-1/, 'first started -> first born');
  assert.match(byId['tu-2nd'], /OUT-2/, 'second -> second');
  assert.match(byId['tu-3rd'], /OUT-3/, 'third -> third');
});

test('identical text with FEWER distinct files than calls refuses both', async (t) => {
  // Two calls, two processes, ONE file between them: nothing says which call
  // wrote it. Note the wrapper test above is the same shape at K=1 and RESOLVES
  // -- one call may legitimately be held by many pids. What forbids a claim here
  // is that the number of distinct files does not match the number of CALLS.
  //
  // This test and the two after it are what remains true of the deleted
  // 'two IDENTICAL concurrent commands resolve to NOTHING rather than guessing':
  // that test's own fixture (two calls, two distinct free files) is precisely
  // the case this ticket teaches the resolver to decide, so it asserted the
  // defect and could not survive the fix. Its still-true half -- that a refused
  // row keeps its command and its elapsed counter, since that counter is what
  // the pane shows in the output's place -- is re-asserted below.
  const root = tmpRoot(t);
  const cwd = '/proj/ambig-few';
  const tasks = tasksDirFor(cwd, 'sess', { uid: 7, tmpdir: root });
  fs.mkdirSync(tasks, { recursive: true });

  const cmd = 'make -j8';
  observeSeries(root, cwd, ['tu-p', 'tu-q'], cmd, { uid: 7, tmpdir: root });
  const shared = path.join(tasks, 'bSHARE001.output');
  fs.writeFileSync(shared, 'WHOSE-OUTPUT\n');

  const live = createBashLive({
    REGISTRY_DIR: root,
    resolveOwners: () => [
      { pid: '9001', args: realArgv(cmd), file: shared },
      { pid: '9002', args: realArgv(cmd), file: shared },
    ],
  });
  t.after(() => live.stopAll());
  live.read('seat');
  await sleep(150);
  const rows = live.read('seat');

  assert.deepStrictEqual(rows.map((r) => r.id).sort(), ['tu-p', 'tu-q'],
    'ENTER: both rows exist, so the refusal below is asserted over the real pair');
  assert.deepStrictEqual(rows.map((r) => r.resolved), [false, false],
    'neither call may be given output that might belong to the other');
  assert.deepStrictEqual(rows.map((r) => r.output), ['', ''],
    'and no bytes of it leaked into either row');
  for (const r of rows) {
    assert.strictEqual(r.command, cmd);
    assert.strictEqual(typeof r.elapsedMs, 'number',
      'a refused row still carries the elapsed counter the pane shows in place of output');
  }
});

test('identical text with MORE distinct files than calls refuses too', async (t) => {
  // A third holder of a third candidate file means one of the three files was
  // not written by either waiting call -- so index-pairing the two calls into a
  // three-long ordering would attribute at least one of them wrongly.
  const root = tmpRoot(t);
  const cwd = '/proj/ambig-many';
  const tasks = tasksDirFor(cwd, 'sess', { uid: 7, tmpdir: root });
  fs.mkdirSync(tasks, { recursive: true });

  const cmd = 'pytest -q';
  observeSeries(root, cwd, ['tu-r', 'tu-s'], cmd, { uid: 7, tmpdir: root });
  const f1 = path.join(tasks, 'bONE00001.output');
  const f2 = path.join(tasks, 'bTWO00001.output');
  const f3 = path.join(tasks, 'bTHREE001.output');
  await birthOrdered([[f1, 'OUT-1\n'], [f2, 'OUT-2\n'], [f3, 'OUT-3\n']]);

  const live = createBashLive({
    REGISTRY_DIR: root,
    resolveOwners: () => [
      { pid: '9101', args: realArgv(cmd), file: f1 },
      { pid: '9102', args: realArgv(cmd), file: f2 },
      { pid: '9103', args: realArgv(cmd), file: f3 },
    ],
  });
  t.after(() => live.stopAll());
  live.read('seat');
  await sleep(150);
  const rows = live.read('seat');

  assert.deepStrictEqual(rows.map((r) => r.id).sort(), ['tu-r', 'tu-s'],
    'ENTER: both rows exist');
  assert.deepStrictEqual(rows.map((r) => r.resolved), [false, false],
    'three files for two calls is not an ordering problem, it is an unknown');
});

// The tie fixtures drive the `statFile` seam rather than the disk: fs.utimesSync
// sets mtime and atime, never birthtime, so a tie on the value the resolver
// actually prefers is not expressible with real files on APFS.
function statStub(times) {
  return (p) => {
    if (!(p in times)) return fs.statSync(p);
    return times[p];
  };
}

test('identical text whose files share a creation time refuses the whole group', async (t) => {
  const root = tmpRoot(t);
  const cwd = '/proj/tie';
  const tasks = tasksDirFor(cwd, 'sess', { uid: 7, tmpdir: root });
  fs.mkdirSync(tasks, { recursive: true });

  const cmd = 'go build ./...';
  observeSeries(root, cwd, ['tu-x', 'tu-y'], cmd, { uid: 7, tmpdir: root });
  const fa = path.join(tasks, 'bTIEA0001.output');
  const fb = path.join(tasks, 'bTIEB0001.output');
  fs.writeFileSync(fa, 'A-OUT\n');
  fs.writeFileSync(fb, 'B-OUT\n');

  const owners = () => [
    { pid: '9201', args: realArgv(cmd), file: fa },
    { pid: '9202', args: realArgv(cmd), file: fb },
  ];
  const run = async (statFile) => {
    const live = createBashLive({ REGISTRY_DIR: root, resolveOwners: owners, statFile });
    try {
      live.read('seat');
      await sleep(150);
      return live.read('seat');
    } finally { live.stopAll(); }
  };

  const tied = await run(statStub({
    [fa]: { birthtimeMs: 5000, mtimeMs: 5000 },
    [fb]: { birthtimeMs: 5000, mtimeMs: 9000 },
  }));
  assert.deepStrictEqual(tied.map((r) => r.id).sort(), ['tu-x', 'tu-y'], 'ENTER: both rows exist');
  assert.deepStrictEqual(tied.map((r) => r.resolved), [false, false],
    'equal birthtimes leave no ordering to pair on, and mtime must not be consulted to break it');

  // ENTER for the refusal above: the SAME fixture, separated only by the
  // birthtimes, does resolve -- so the tie is what refused it and not some
  // unrelated thing about the fixture never reaching the pairing.
  const split = await run(statStub({
    [fa]: { birthtimeMs: 5000, mtimeMs: 5000 },
    [fb]: { birthtimeMs: 5001, mtimeMs: 9000 },
  }));
  const byId = Object.fromEntries(split.map((r) => [r.id, r.output]));
  assert.match(byId['tu-x'], /A-OUT/, 'ENTER: one birthtime apart and the earlier call gets the earlier file');
  assert.match(byId['tu-y'], /B-OUT/, 'ENTER: and the later call gets the later one');
});

test('mtime stands in for a missing birthtime, and only while it stays strict', async (t) => {
  const root = tmpRoot(t);
  const cwd = '/proj/mtime';
  const tasks = tasksDirFor(cwd, 'sess', { uid: 7, tmpdir: root });
  fs.mkdirSync(tasks, { recursive: true });

  const cmd = 'cargo test';
  observeSeries(root, cwd, ['tu-m', 'tu-n'], cmd, { uid: 7, tmpdir: root });
  const fa = path.join(tasks, 'bMTA00001.output');
  const fb = path.join(tasks, 'bMTB00001.output');
  fs.writeFileSync(fa, 'M-OUT\n');
  fs.writeFileSync(fb, 'N-OUT\n');

  const owners = () => [
    { pid: '9301', args: realArgv(cmd), file: fa },
    { pid: '9302', args: realArgv(cmd), file: fb },
  ];
  const run = async (statFile) => {
    const live = createBashLive({ REGISTRY_DIR: root, resolveOwners: owners, statFile });
    try {
      live.read('seat');
      await sleep(150);
      return live.read('seat');
    } finally { live.stopAll(); }
  };

  const fell = await run(statStub({
    [fa]: { birthtimeMs: 0, mtimeMs: 4000 },
    [fb]: { birthtimeMs: 0, mtimeMs: 4001 },
  }));
  const byId = Object.fromEntries(fell.map((r) => [r.id, r.output]));
  assert.deepStrictEqual(Object.keys(byId).sort(), ['tu-m', 'tu-n'], 'ENTER: both rows exist');
  assert.match(byId['tu-m'], /M-OUT/, 'a filesystem with no birthtime still pairs, by mtime');
  assert.match(byId['tu-n'], /N-OUT/, 'and the second call gets the second file');

  const tied = await run(statStub({
    [fa]: { birthtimeMs: 0, mtimeMs: 4000 },
    [fb]: { birthtimeMs: 0, mtimeMs: 4000 },
  }));
  assert.deepStrictEqual(tied.map((r) => r.resolved), [false, false],
    'the fallback is not a weaker rule: a tie in mtime refuses exactly as a tie in birthtime does');

  const unusable = await run(statStub({
    [fa]: { birthtimeMs: NaN, mtimeMs: NaN },
    [fb]: { birthtimeMs: NaN, mtimeMs: 8000 },
  }));
  assert.deepStrictEqual(unusable.map((r) => r.resolved), [false, false],
    'and a file whose times are unreadable refuses rather than sorting as zero');
});

test('a wrapper and its forked child sharing one file do not defeat resolution', async (t) => {
  // MEASURED on this box, not hypothesised: a zsh subshell that forks WITHOUT
  // exec'ing keeps the parent's argv verbatim, and both processes hold fd 1 on
  // the SAME .output file. `lsof -Fpf` on one live call returned two such pids,
  // both carrying the identical needle. Refusing on `hits.length !== 1` asks
  // whether the PROCESS is unique; the question that decides ownership is
  // whether the FILE is, and on a box with any wrapper in the chain those two
  // answers differ -- the call goes permanently unresolved and the pane shows an
  // empty refusal row for the whole run.
  const root = tmpRoot(t);
  const cwd = '/proj/wrap';
  const tasks = tasksDirFor(cwd, 'sess', { uid: 7, tmpdir: root });
  fs.mkdirSync(tasks, { recursive: true });
  observe(root, 'seat', { id: 'tu-1', command: 'long-build', cwd, sessionId: 'sess' }, { uid: 7, tmpdir: root });
  const file = path.join(tasks, 'bWRAP0001.output');
  fs.writeFileSync(file, 'BUILD-OUTPUT\n');

  const live = createBashLive({
    REGISTRY_DIR: root,
    // Two pids, one file: the wrapper and the shell it forked.
    resolveOwners: () => [
      { pid: '5001', args: realArgv('long-build'), file },
      { pid: '5002', args: realArgv('long-build'), file },
    ],
  });
  t.after(() => live.stopAll());
  live.read('seat');
  await sleep(150);
  const rows = live.read('seat');

  assert.strictEqual(rows.length, 1, 'ENTER: the call has a row');
  assert.strictEqual(rows[0].resolved, true,
    'two holders of ONE file is not an ambiguity — the file is what ownership is about');
  assert.match(rows[0].output, /BUILD-OUTPUT/, 'and its output reaches the row');
});

test('a holder whose fd 1 is a tty does not make the file look ambiguous', async (t) => {
  // The dedupe asks whether the FILE is unique, and a wrapper in the chain need
  // not hold a task file at all -- an interactive shell's fd 1 is its tty, which
  // is an absolute path and so survives the resolver's own filter. Counting it
  // as a second file refuses a call whose ownership is not in doubt, which is
  // the silent-off shape the file dedupe was introduced to remove, one layer out.
  const root = tmpRoot(t);
  const cwd = '/proj/tty';
  const tasks = tasksDirFor(cwd, 'sess', { uid: 7, tmpdir: root });
  fs.mkdirSync(tasks, { recursive: true });
  observe(root, 'seat', { id: 'tu-1', command: 'tty-build', cwd, sessionId: 'sess' }, { uid: 7, tmpdir: root });
  const file = path.join(tasks, 'bTTY00001.output');
  fs.writeFileSync(file, 'TTY-OUTPUT\n');

  const live = createBashLive({
    REGISTRY_DIR: root,
    resolveOwners: () => [
      { pid: '6001', args: realArgv('tty-build'), file },
      { pid: '6002', args: realArgv('tty-build'), file: '/dev/ttys003' },
    ],
  });
  t.after(() => live.stopAll());
  live.read('seat');
  await sleep(150);
  const rows = live.read('seat');

  assert.strictEqual(rows.length, 1, 'ENTER: the call has a row');
  assert.strictEqual(rows[0].resolved, true,
    'a non-task holder is not a competing claim on the output');
  assert.match(rows[0].output, /TTY-OUTPUT/, 'and its output reaches the row');
});

test('a tty holder does not collapse a genuine two-file ambiguity', async (t) => {
  // The other direction of the same filter: discarding non-task holders must not
  // discard a real competitor. Two task files under one needle is undecidable
  // whether or not a tty is also in the list.
  const root = tmpRoot(t);
  const cwd = '/proj/ttyamb';
  const tasks = tasksDirFor(cwd, 'sess', { uid: 7, tmpdir: root });
  fs.mkdirSync(tasks, { recursive: true });
  observe(root, 'seat', { id: 'tu-1', command: 'amb-build', cwd, sessionId: 'sess' }, { uid: 7, tmpdir: root });
  const fileA = path.join(tasks, 'bAMB00001.output');
  const fileB = path.join(tasks, 'bAMB00002.output');
  fs.writeFileSync(fileA, 'AMB-A\n');
  fs.writeFileSync(fileB, 'AMB-B\n');

  const live = createBashLive({
    REGISTRY_DIR: root,
    resolveOwners: () => [
      { pid: '6101', args: realArgv('amb-build'), file: fileA },
      { pid: '6102', args: realArgv('amb-build'), file: fileB },
      { pid: '6103', args: realArgv('amb-build'), file: '/dev/ttys003' },
    ],
  });
  t.after(() => live.stopAll());
  live.read('seat');
  await sleep(150);
  const rows = live.read('seat');

  assert.strictEqual(rows.length, 1, 'ENTER: the call has a row, so the emptiness below is a refusal');
  assert.strictEqual(rows[0].resolved, false, 'two task files under one needle stays undecidable');
  assert.strictEqual(rows[0].output, '', 'and nothing is guessed');
});

test('ps is asked for UNTRUNCATED argv', () => {
  // Measured: through a PTY a bare `ps -ax` truncated a 3000-char argv to 72
  // characters. A truncated argv cannot contain the needle, so the feature turns
  // itself off silently, and the failure scales with command length -- long
  // commands being exactly the ones worth previewing.
  let psArgs = null;
  const exec = (bin, args) => {
    if (bin === 'ps') { psArgs = args; return ''; }
    return '';
  };
  defaultResolveOwners([argvNeedle('anything')], { exec });
  assert.ok(psArgs, 'ENTER: ps really was invoked, so the flag assertion below is not vacuous');
  assert.ok(psArgs.some((a) => a.includes('ww')),
    `ps must be asked for wide output, got ${JSON.stringify(psArgs)}`);
});

test('a tasks dir behind a symlink is keyed the way lsof reports it', async (t) => {
  // Defect 1's shape a second time. lsof reports the RESOLVED path; on macOS
  // /tmp is a symlink to /private/tmp, so a payload carrying the unresolved form
  // keys candidates under a path lsof never names and nothing ever matches.
  const root = tmpRoot(t);
  const realTasks = path.join(root, 'real', 'sess', 'tasks');
  fs.mkdirSync(realTasks, { recursive: true });
  const linkRoot = path.join(root, 'link');
  fs.symlinkSync(path.join(root, 'real'), linkRoot);

  const viaLink = path.join(linkRoot, 'sess', 'tasks');
  assert.notStrictEqual(viaLink, realTasks, 'ENTER: the two spellings really do differ');
  assert.strictEqual(fs.realpathSync(viaLink), realTasks, 'ENTER: and they name the same dir');

  // The payload gives the SYMLINKED spelling, as a hook on a box with a linked
  // tmp would; lsof will report the resolved one.
  observe(root, 'seat', {
    id: 'tu-1', command: 'via-link', cwd: '/proj/link', sessionId: 'sess',
    scratchpadDir: path.join(linkRoot, 'sess', 'scratchpad'),
  }, { uid: 7, tmpdir: root });

  const file = path.join(realTasks, 'bLINK0001.output');
  fs.writeFileSync(file, 'LINKED-OUTPUT\n');

  const live = createBashLive({
    REGISTRY_DIR: root,
    resolveOwners: resolverOf([['via-link', file]]),
  });
  t.after(() => live.stopAll());
  live.read('seat');
  await sleep(150);
  const rows = live.read('seat');

  assert.strictEqual(rows.length, 1, 'ENTER: the call has a row');
  assert.match(rows[0].output, /LINKED-OUTPUT/,
    'the payload spelling must be resolved into lsof\'s namespace, or nothing ever matches');
});

test('a failed openWatch is retried, not cached as dead for the seat\'s lifetime', async (t) => {
  // A transient EMFILE, or a tasks dir the CLI has not created yet, must not
  // disable live output for the rest of the seat. Release path: the null entry
  // is dropped by the next ensureWatch that runs WATCH_RETRY_MS after the
  // failure, so recovery needs no new timer and no extra state beyond the stamp.
  const root = tmpRoot(t);
  const cwd = '/proj/emfile';
  const tasks = tasksDirFor(cwd, 'sess', { uid: 7, tmpdir: root });
  fs.mkdirSync(tasks, { recursive: true });

  let clock = 1_000_000;
  observe(root, 'seat', { id: 'tu-1', command: 'watched', cwd, sessionId: 'sess' },
    { uid: 7, tmpdir: root, now: () => clock });
  const file = path.join(tasks, 'bEMFILE01.output');
  fs.writeFileSync(file, 'AFTER-RECOVERY\n');

  let attempts = 0;
  const live = createBashLive({
    REGISTRY_DIR: root,
    now: () => clock,
    watch: () => {
      attempts++;
      if (attempts === 1) throw Object.assign(new Error('EMFILE'), { code: 'EMFILE' });
      return { close() {}, on() {} };
    },
    resolveOwners: resolverOf([['watched', file]]),
  });
  t.after(() => live.stopAll());

  live.read('seat');
  assert.strictEqual(attempts, 1, 'ENTER: the first open really did fail');

  // Inside the retry window nothing is re-attempted, or a wedged dir would cost
  // an fs.watch on every read.
  live.read('seat');
  assert.strictEqual(attempts, 1, 'a failure is not retried on the very next read');

  clock += 3000 + 1;
  live.read('seat');
  assert.strictEqual(attempts, 2, 'but the window expiring re-opens it — the cache is not permanent');

  const rows = live.read('seat');
  assert.strictEqual(rows.length, 1, 'ENTER: the call still has a row after recovery');
  assert.match(rows[0].output, /AFTER-RECOVERY/, 'and live output resumes');
});

test('an ALREADY-OWNED file still counts as a competing claim', async (t) => {
  // The dedupe discards holders whose file is not a task file, and it must weigh
  // ALL task files, not only the unclaimed ones. Narrowing to free files instead
  // makes a second, already-attributed file vanish from the count, and the
  // ambiguity it represented disappears with it -- the observer then claims the
  // one file left over, which is a guess dressed as a unique answer and exactly
  // what constraint 1 forbids.
  const root = tmpRoot(t);
  const cwd = '/proj/owned';
  const tasks = tasksDirFor(cwd, 'sess', { uid: 7, tmpdir: root });
  fs.mkdirSync(tasks, { recursive: true });

  let clock = 1_000_000;
  const opts = { uid: 7, tmpdir: root, now: () => clock };
  const fileB = path.join(tasks, 'bOWN00001.output');
  const fileG = path.join(tasks, 'bOWN00002.output');
  fs.writeFileSync(fileB, 'BEE-OUT\n');
  fs.writeFileSync(fileG, 'GEE-OUT\n');

  observe(root, 'seat', { id: 'tu-B', command: 'bee', cwd, sessionId: 'sess' }, opts);

  let both = false;
  const live = createBashLive({
    REGISTRY_DIR: root,
    now: () => clock,
    resolveOwners: () => (both
      ? [
        { pid: '1', args: realArgv('bee'), file: fileB },
        { pid: '2', args: realArgv('aye'), file: fileB },
        { pid: '3', args: realArgv('aye'), file: fileG },
      ]
      : [{ pid: '1', args: realArgv('bee'), file: fileB }]),
  });
  t.after(() => live.stopAll());

  live.read('seat');
  await sleep(150);
  const first = live.read('seat');
  assert.strictEqual(first.length, 1, 'ENTER: only B is in flight so far');
  assert.strictEqual(first[0].resolved, true, 'ENTER: and B really did claim its file, so it is OWNED below');

  clock += 500;
  observe(root, 'seat', { id: 'tu-A', command: 'aye', cwd, sessionId: 'sess' }, opts);
  both = true;
  live.read('seat');
  await sleep(150);
  const rows = live.read('seat');

  const a = rows.find((r) => r.command === 'aye');
  assert.ok(a, 'ENTER: A has a row of its own');
  assert.strictEqual(a.resolved, false,
    'two task files under one needle is undecidable even when one of them is already claimed');
  assert.strictEqual(a.output, '', 'so nothing is attributed to A');
});

test('a call that keeps missing backs its probe off', async (t) => {
  // Each probe is ~26ms of SYNCHRONOUS work on the Electron main thread -- the
  // one that draws the whole app -- and 26ms overruns a 16ms frame. At the
  // 500ms poll that is a ~5% duty cycle sustained for the whole resolve window,
  // which the operator perceives as the app going sticky. The first few reads
  // still probe eagerly, because the common case resolves within a tick or two.
  const root = tmpRoot(t);
  const cwd = '/proj/backoff';
  const tasks = tasksDirFor(cwd, 'sess', { uid: 7, tmpdir: root });
  fs.mkdirSync(tasks, { recursive: true });

  let clock = 1_000_000;
  observe(root, 'seat', { id: 'tu-1', command: 'never-matches', cwd, sessionId: 'sess' },
    { uid: 7, tmpdir: root, now: () => clock });
  fs.writeFileSync(path.join(tasks, 'bBACK0001.output'), 'X\n');

  let probes = 0;
  const live = createBashLive({
    REGISTRY_DIR: root,
    now: () => clock,
    resolveOwners: () => { probes++; return []; },
  });
  t.after(() => live.stopAll());

  live.read('seat');
  await sleep(120);
  const eager = probes;
  assert.ok(eager > 0, 'ENTER: the first read really did probe, so the ceiling below means something');

  // Twenty reads at the real cadence, no clock movement beyond the poll itself.
  for (let i = 0; i < 20; i++) { clock += 500; live.read('seat'); }
  const spent = probes - eager;
  assert.ok(spent < 20,
    `a repeatedly-missing probe must not run on every read; 20 reads spent ${spent} probes`);
  assert.ok(spent > 0, 'ENTER: it still probes sometimes — a permanent stop would never recover');
});

test('a probe that SUCCEEDS resets the backoff, so the next call is not penalised', async (t) => {
  // The backoff is per-seat, and a seat runs many calls. Without a reset the
  // penalty earned by one slow call is paid by every later one.
  const root = tmpRoot(t);
  const cwd = '/proj/reset';
  const tasks = tasksDirFor(cwd, 'sess', { uid: 7, tmpdir: root });
  fs.mkdirSync(tasks, { recursive: true });

  let clock = 1_000_000;
  observe(root, 'seat', { id: 'tu-1', command: 'resolves', cwd, sessionId: 'sess' },
    { uid: 7, tmpdir: root, now: () => clock });
  const file = path.join(tasks, 'bRESET001.output');
  fs.writeFileSync(file, 'GOT-IT\n');

  let hit = false;
  const live = createBashLive({
    REGISTRY_DIR: root,
    now: () => clock,
    resolveOwners: () => (hit ? [{ pid: '7', args: realArgv('resolves'), file }] : []),
  });
  t.after(() => live.stopAll());

  // Miss enough times to earn a real wait.
  for (let i = 0; i < 8; i++) { clock += 500; live.read('seat'); }
  hit = true;
  clock += 20000;
  live.read('seat');
  await sleep(120);
  const rows = live.read('seat');

  assert.strictEqual(rows.length, 1, 'ENTER: the call has a row');
  assert.match(rows[0].output, /GOT-IT/, 'a backed-off seat still resolves once the process appears');
});

test('a NEWLY started call does not inherit an older call\'s backoff penalty', async (t) => {
  // The backoff counter is per-SEAT, but the reason to back off is per-CALL: one
  // permanently unresolvable observer drives the seat to the longest bucket, and
  // a call started afterwards then waits that whole bucket for its FIRST probe.
  // Nothing is lost -- the claim tails from offset 0 -- but the operator's
  // headline case is starting something and wanting to watch it now, so a blind
  // window there is the one place the backoff must not reach.
  const root = tmpRoot(t);
  const cwd = '/proj/newcall';
  const tasks = tasksDirFor(cwd, 'sess', { uid: 7, tmpdir: root });
  fs.mkdirSync(tasks, { recursive: true });

  let clock = 1_000_000;
  const opts = { uid: 7, tmpdir: root, now: () => clock };
  observe(root, 'seat', { id: 'tu-stuck', command: 'never-matches', cwd, sessionId: 'sess' }, opts);

  // A candidate the stuck call can never claim: without one, assign() returns
  // before it reaches the probe at all and the seat never earns a penalty to
  // inherit -- which is how the first version of this test passed pre-fix.
  fs.writeFileSync(path.join(tasks, 'bNEWSTUCK.output'), 'STUCK\n');
  const file = path.join(tasks, 'bNEW00001.output');
  let started = false;
  let probes = 0;
  const live = createBashLive({
    REGISTRY_DIR: root,
    now: () => clock,
    resolveOwners: () => {
      probes++;
      return started ? [{ pid: '8', args: realArgv('fresh-call'), file }] : [];
    },
  });
  t.after(() => live.stopAll());

  for (let i = 0; i < 10; i++) { clock += 500; live.read('seat'); }
  const spent = probes;
  assert.ok(spent > 0 && spent < 10,
    `ENTER: the stuck call really did back the seat off (${spent} probes over 10 reads)`);
  assert.strictEqual(live.read('seat').length, 1,
    'ENTER: and it is still unresolved, so the wait it earned is live');

  clock += 500;
  observe(root, 'seat', { id: 'tu-fresh', command: 'fresh-call', cwd, sessionId: 'sess' }, opts);
  fs.writeFileSync(file, 'FRESH-OUTPUT\n');
  started = true;
  live.read('seat');
  await sleep(150);
  const rows = live.read('seat');

  const fresh = rows.find((r) => r.command === 'fresh-call');
  assert.ok(fresh, 'ENTER: the new call has a row of its own');
  assert.strictEqual(fresh.resolved, true,
    'a call that has not yet missed anything must be probed on its first read');
  assert.match(fresh.output, /FRESH-OUTPUT/, 'and its output is already streaming');
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
  // instead NORMALIZES both sides can never match a
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
  // The case a whitespace-collapsing matcher cannot match at all. Bytes below
  // are a live `ps -o args=`
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
  // sweep in the gap between two Bash calls.
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
