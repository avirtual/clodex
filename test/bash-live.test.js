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
  createBashLive, writeObserver, pruneObservers, tasksDirFor, commandFingerprint,
  OBSERVER_MAX_FILES, TASK_OUTPUT_RE, LIVE_MAX_BYTES, EVENT_QUEUE_MAX, WATCH_SENTINEL,
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
  // subagent's first Bash call — so the obvious "newest .output file" heuristic
  // picks it and streams a transcript into the console.
  const root = tmpRoot(t);
  const cwd = '/proj/sym';
  const tasks = tasksDirFor(cwd, 'sess', { uid: 7, tmpdir: root });
  fs.mkdirSync(tasks, { recursive: true });
  const target = path.join(root, 'transcript-target');
  fs.writeFileSync(target, 'SUBAGENT-TRANSCRIPT-TEXT\n');
  fs.symlinkSync(target, path.join(tasks, 'agent-99.output'));

  observe(root, 'seat', { id: 'tu-1', command: 'sleep 1', cwd, sessionId: 'sess' },
    { uid: 7, tmpdir: root });

  const live = createBashLive({ REGISTRY_DIR: root });
  t.after(() => live.stopAll());
  live.read('seat');
  await sleep(60);
  const rows = live.read('seat');

  assert.deepStrictEqual(rows, [], 'a symlink is not a task file, so the call has no candidate yet');

  const real = path.join(tasks, 'bREALFILE.output');
  fs.writeFileSync(real, 'REAL-OUTPUT\n');
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

  const live = createBashLive({ REGISTRY_DIR: root });
  t.after(() => live.stopAll());
  live.read('seat');

  const file = path.join(tasks, 'bSTREAM01.output');
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

  const live = createBashLive({ REGISTRY_DIR: root });
  t.after(() => live.stopAll());
  live.read('seat');

  const file = path.join(tasks, 'bFINAL001.output');
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

test('two calls landing together are told apart by their snapshots, with no lsof', async (t) => {
  // The cheap path, and the reason the design is affordable: each observer
  // snapshots the dir at PreToolUse, so a file absent from A's snapshot but
  // present in B's belongs to A by construction.
  const root = tmpRoot(t);
  const cwd = '/proj/two';
  const tasks = tasksDirFor(cwd, 'sess', { uid: 7, tmpdir: root });
  fs.mkdirSync(tasks, { recursive: true });

  observe(root, 'seat', { id: 'tu-A', command: 'cmd A', cwd, sessionId: 'sess' }, { uid: 7, tmpdir: root });
  const fileA = path.join(tasks, 'bAAAA0001.output');
  fs.writeFileSync(fileA, 'A-OUT\n');
  // B is observed AFTER A's file exists, so A's file is inside B's snapshot.
  observe(root, 'seat', { id: 'tu-B', command: 'cmd B', cwd, sessionId: 'sess' }, { uid: 7, tmpdir: root });
  const fileB = path.join(tasks, 'bBBBB0001.output');
  fs.writeFileSync(fileB, 'B-OUT\n');

  let probes = 0;
  const live = createBashLive({
    REGISTRY_DIR: root,
    probeOwner: () => { probes++; return null; },
  });
  t.after(() => live.stopAll());
  live.read('seat');
  await sleep(150);
  const rows = live.read('seat');

  const byCmd = Object.fromEntries(rows.map((r) => [r.command, r.output]));
  assert.deepStrictEqual(Object.keys(byCmd).sort(), ['cmd A', 'cmd B'],
    'ENTER: both calls were painted, so the pairing below is not asserted over one row');
  assert.match(byCmd['cmd A'], /A-OUT/, 'A gets the file that was absent from B\'s snapshot');
  assert.match(byCmd['cmd B'], /B-OUT/, 'and B gets the one that appeared after it');
  assert.strictEqual(probes, 0, 'snapshots alone resolved it — lsof is for a GENUINE collision only');
});

test('a genuine collision falls back to exactly one probe, per collision', async (t) => {
  // Both observers snapshot the same empty dir, so neither file is excluded by
  // a snapshot and the free path cannot decide. This is the only case that may
  // spend an lsof, and it must spend it once — not once per read.
  const root = tmpRoot(t);
  const cwd = '/proj/coll';
  const tasks = tasksDirFor(cwd, 'sess', { uid: 7, tmpdir: root });
  fs.mkdirSync(tasks, { recursive: true });

  observe(root, 'seat', { id: 'tu-A', command: 'alpha-cmd', cwd, sessionId: 'sess' }, { uid: 7, tmpdir: root });
  observe(root, 'seat', { id: 'tu-B', command: 'beta-cmd', cwd, sessionId: 'sess' }, { uid: 7, tmpdir: root });
  fs.writeFileSync(path.join(tasks, 'bCOLL0001.output'), 'ALPHA-OUT\n');
  fs.writeFileSync(path.join(tasks, 'bCOLL0002.output'), 'BETA-OUT\n');

  const probed = [];
  const live = createBashLive({
    REGISTRY_DIR: root,
    probeOwner: (f) => {
      probed.push(f);
      return f.endsWith('bCOLL0001.output') ? '/bin/zsh -c alpha-cmd' : '/bin/zsh -c beta-cmd';
    },
  });
  t.after(() => live.stopAll());
  live.read('seat');
  await sleep(150);
  const rows = live.read('seat');
  const afterFirst = probed.length;

  const byCmd = Object.fromEntries(rows.map((r) => [r.command, r.output]));
  assert.deepStrictEqual(Object.keys(byCmd).sort(), ['alpha-cmd', 'beta-cmd'],
    'ENTER: both collided rows were painted');
  assert.match(byCmd['alpha-cmd'], /ALPHA-OUT/, 'the probe resolved each file to its own command');
  assert.match(byCmd['beta-cmd'], /BETA-OUT/);
  assert.ok(afterFirst > 0 && afterFirst <= 2, `one probe per colliding file, got ${afterFirst}`);

  live.read('seat');
  live.read('seat');
  assert.strictEqual(probed.length, afterFirst,
    'later reads must NOT re-probe: the assignment is remembered, or this is polling by another name');
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

  assert.deepStrictEqual(live.read('seat'), [], 'no file yet, so nothing to show');
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

test('commandFingerprint collapses whitespace so a probe can match a respawned argv', () => {
  assert.strictEqual(commandFingerprint('  a   b\n c  '), 'a b c');
  assert.strictEqual(commandFingerprint(null), '');
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

test('the sweep is disarmed once nothing is watched, and re-armed by the next call', async (t) => {
  // The other half: a timer that outlives its last watch is the same leak in a
  // cheaper currency, and an unref'd interval running forever is invisible.
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
  assert.strictEqual(sweep, null, 'with nothing watched the sweep stops rather than ticking forever');

  observe(root, 'seat2', { id: 'tu-2', command: 'y', cwd, sessionId: 'sess' }, { uid: 7, tmpdir: root });
  live.read('seat2');
  assert.strictEqual(armed, 2, 'and a later call re-arms it — disarming must not be permanent');
});

test('a probe that cannot resolve the owner is not retried every tick', async (t) => {
  // The cost defect: an unresolved candidate recorded nothing, so every read
  // re-ran defaultProbeOwner — two execFileSync calls with 5s timeouts — at the
  // tab's cadence. That is exactly the per-tick lsof the design exists to avoid.
  // The round-1 test only ever exercised a SUCCEEDING stub, so its "no re-probe"
  // assertion passed for the wrong reason.
  const root = tmpRoot(t);
  const cwd = '/proj/failprobe';
  const tasks = tasksDirFor(cwd, 'sess', { uid: 7, tmpdir: root });
  fs.mkdirSync(tasks, { recursive: true });

  observe(root, 'seat', { id: 'tu-A', command: 'alpha', cwd, sessionId: 'sess' }, { uid: 7, tmpdir: root });
  observe(root, 'seat', { id: 'tu-B', command: 'beta', cwd, sessionId: 'sess' }, { uid: 7, tmpdir: root });
  fs.writeFileSync(path.join(tasks, 'bFAIL0001.output'), 'X\n');
  fs.writeFileSync(path.join(tasks, 'bFAIL0002.output'), 'Y\n');

  let probes = 0;
  const live = createBashLive({
    REGISTRY_DIR: root,
    probeOwner: () => { probes++; return null; },
  });
  t.after(() => live.stopAll());
  live.read('seat');
  await sleep(150);
  live.read('seat');
  const afterFirst = probes;
  assert.ok(afterFirst > 0, 'ENTER: the collision really did reach the probe, so the ceiling below is meaningful');

  for (let i = 0; i < 10; i++) live.read('seat');
  assert.strictEqual(probes, afterFirst,
    `a failed probe must back off; 10 further reads added ${probes - afterFirst} probes`);
});

test('a probe matches an argv that is not whitespace-normalized', async (t) => {
  // `ps -o args=` returns the command as spawned — a multi-line agent Bash call
  // keeps its newlines and runs of spaces. Normalizing only the fingerprint side
  // meant such a command never matched, silently forcing the unresolved path for
  // exactly the calls most worth previewing.
  const root = tmpRoot(t);
  const cwd = '/proj/multiline';
  const tasks = tasksDirFor(cwd, 'sess', { uid: 7, tmpdir: root });
  fs.mkdirSync(tasks, { recursive: true });

  // BOTH are multi-line on purpose. With only one, the other resolves by name,
  // and the constraint propagation then hands the leftover file to the leftover
  // observer on the NEXT read — so the test passes without the normalization
  // fix. Two unmatchable commands leave the propagation nothing to work with,
  // which is what makes this test discriminate.
  const multiA = 'for f in *.js; do\n  echo "$f"\ndone';
  const multiB = 'while read l; do\n  printf "%s" "$l"\ndone';
  observe(root, 'seat', { id: 'tu-A', command: multiA, cwd, sessionId: 'sess' }, { uid: 7, tmpdir: root });
  observe(root, 'seat', { id: 'tu-B', command: multiB, cwd, sessionId: 'sess' }, { uid: 7, tmpdir: root });
  fs.writeFileSync(path.join(tasks, 'bMULTI001.output'), 'M-A\n');
  fs.writeFileSync(path.join(tasks, 'bMULTI002.output'), 'M-B\n');

  const live = createBashLive({
    REGISTRY_DIR: root,
    // Raw, exactly as ps prints it: newlines intact, not collapsed.
    probeOwner: (f) => (f.endsWith('bMULTI001.output')
      ? `/bin/zsh -c ${multiA}`
      : `/bin/zsh -c ${multiB}`),
  });
  t.after(() => live.stopAll());
  live.read('seat');
  await sleep(150);
  live.read('seat');
  const rows = live.read('seat');

  const byCmd = Object.fromEntries(rows.map((r) => [r.command, r.output]));
  assert.deepStrictEqual(Object.keys(byCmd).sort(), [multiA, multiB].sort(),
    'ENTER: both multi-line calls were painted, so the pairing below is real');
  assert.match(byCmd[multiA], /M-A/, 'each multi-line call got ITS file, not left unresolved');
  assert.match(byCmd[multiB], /M-B/);
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

  let fire = null;
  const live = createBashLive({
    REGISTRY_DIR: root,
    watch: (dir, cb) => { fire = cb; return { close() {} }; },
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

  const file = path.join(tasks, 'bBURST001.output');
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

  const live = createBashLive({ REGISTRY_DIR: root });
  t.after(() => live.stopAll());
  live.read('seat');

  const huge = LIVE_MAX_BYTES * 8;
  const body = `${'a'.repeat(huge)}\nTAIL-MARKER\n`;
  fs.writeFileSync(path.join(tasks, 'bHUGE0001.output'), body);

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
