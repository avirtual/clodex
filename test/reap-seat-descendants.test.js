'use strict';

// Run: node --test test/reap-seat-descendants.test.js
//
// Killing a seat must kill what its CLI spawned.
//
// THE FAILURE, measured on the operator's laptop. Two `node --test` processes
// were found pegged at ~98% CPU each, reparented to init, still running an hour
// after the run nobody was waiting for. One carried a `timeout 300` wrapper that
// had ALSO been orphaned, so its five-minute kill never fired: the wrapper
// survived, its enforcement context did not. Both ignored SIGTERM. Cause:
// `kill()` and `archive()` signalled `s.pty.pid` and nothing beneath it, so a
// CLI's children simply outlived the seat.
//
// The first subject drives a REAL child process — an actual `sleep` whose pid is
// polled until the OS says it is gone. A stub that records a call would pass
// against a reaper that signalled the wrong pid, or none: the bug was never
// "the function wasn't called", it was that a real process stayed alive.
//
// The second subject is the ~277-PROCESS INCIDENT's pin, inherited. `process.kill`
// reads a non-positive pid as a BROADCAST (-1 = every process the user may
// signal; 0 = our own process group), and a fixture's `pid: -1` once SIGKILLed
// the operator's whole desktop three times over. A reaper multiplies that blast
// radius by the size of a process tree, so a non-positive pid arriving from
// discovery must reap NOTHING and say so in the log.
//
// The third subject is why the sign test is NOT enough, measured twice on the
// operator's laptop when an earlier version of this reaper took the machine down
// during a suite run. Dozens of fixtures across this suite seed `pty: { pid: 1 }`
// as a dummy. 1 is POSITIVE, so every guard above passes it — and 1 is launchd,
// so every process on the box is its descendant: 542 of 543 processes, measured.
// The sign of a pid says nothing about whose it is.
//
// The invariant that does: a pty we spawned is ALWAYS a direct child of this
// process, so `ppid === process.pid` is ownership, and it is already in the same
// snapshot discovery walks. A pid that is absent is stale; a pid that is present
// but parented elsewhere belongs to someone else. Neither may be reaped beneath.
// Do not relax this to "pid is alive" or "pid is not 1" — aliveness is what makes
// a stale pid dangerous rather than harmless, and 1 is one value out of an
// unbounded set of real pids a fixture could name.

const { test } = require('node:test');
const assert = require('node:assert');
const childProcess = require('node:child_process');
const { createSessionManager } = require('../session-manager');

function mkManager(log) {
  const store = [];
  const persistence = {
    list: () => store,
    get: (n) => store.find((e) => e.name === n) || null,
    upsert: (e) => { store.push({ ...e }); },
    remove: (n) => { const i = store.findIndex((x) => x.name === n); if (i >= 0) store.splice(i, 1); },
    setArchived: () => {},
  };
  const SessionManager = createSessionManager({
    knownSkillNames: () => [],
    getRemoteServer: () => null,
    getUiSettings: () => ({ get: () => ({}) }),
    getPersistence: () => persistence,
    notifyOS: () => {},
    fs: require('node:fs'),
    childProcess,
    log: log || { info: () => {}, warn: () => {}, error: () => {} },
  });
  const m = new SessionManager();
  m._notifyComposition = () => {};
  return m;
}

function seat(m, name, pid) {
  const s = { name, type: 'claude', cwd: '/proj', workspaceId: 'default', agentType: null, pty: { pid, kill() {} } };
  m.sessions.set(name, s);
  return s;
}

// ── The file-scoped signal fence ──
//
// Installed for the WHOLE file, not per subject, because the thing that escapes a
// per-subject stub is the 5-second backstop: `kill()` arms
// `setTimeout(() => sigkillPid(s.pty.pid, ...), 5000)` with a real timer, and a
// `finally` that restores `process.kill` the instant `await m.kill(...)` resolves
// tears the stub down about five seconds BEFORE that timer fires. Node will not
// exit with the timer pending, so it is guaranteed to fire, not merely likely —
// against the restored, real `process.kill`. Review round 1 measured what this
// file did before the fence: five real `SIGKILL`s at pid 4242 and one at pid 1,
// every single run. 4242 is an ordinary live pid on a box that has been up a
// while, which is this file's own argument from its header.
//
// Only pids THIS FILE spawned are allowed through to the OS. Everything else is
// recorded. That is what makes the header's claim — a test for a guard against
// killing the machine must not kill the machine — true of the file as written,
// and it covers the real-tree subjects' trailing backstop too: that one signals
// an already-dead `sh.pid`, which is a pid-recycle window of its own.
const realKill = process.kill.bind(process);
const spawnedByUs = new Set();
let signalled = [];

process.kill = (pid, sig) => {
  if (spawnedByUs.has(pid)) return realKill(pid, sig);
  signalled.push({ pid, sig });
  return true;
};

// `alive` and `reapFixture` must reach the real OS: they only ever ask about, or
// clean up, pids this file spawned.
function alive(pid) {
  try { realKill(pid, 0); return true; } catch { return false; }
}

async function goneWithin(pid, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!alive(pid)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return !alive(pid);
}

// A real process tree: `sh` holding a `sleep`, so the seat's "pty" has a genuine
// descendant to lose. The sh is the stand-in for the CLI; the sleep is the test
// runner that outlived its seat.
//
// The trailing `; :` is load-bearing. `sh -c 'sleep 120'` is a SINGLE command, so
// the shell execs it and REPLACES itself — one process, no descendant, and the
// tree this file needs never exists. The ENTER subject caught exactly that.
function spawnTree() {
  const sh = childProcess.spawn('/bin/sh', ['-c', 'sleep 120; :'], { stdio: 'ignore' });
  spawnedByUs.add(sh.pid);
  return sh;
}

// The discovered child joins the allowlist: the real-tree subjects require the
// reaper's SIGKILL to actually reach it, since what they assert is that a real
// process DIED. Only ever called on a shell this file spawned.
function childPidOf(parentPid) {
  const out = childProcess.execFileSync('ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8' });
  const kids = out.split('\n').map((l) => l.trim().split(/\s+/))
    .filter((f) => f.length === 2 && Number(f[1]) === parentPid)
    .map((f) => Number(f[0]));
  if (!kids.length) return null;
  spawnedByUs.add(kids[0]);
  return kids[0];
}

// Cleanup runs even when an assertion throws: a leaked `sleep 120` is this
// file's own version of the orphan it exists to pin.
function reapFixture(...pids) {
  for (const p of pids) { if (p > 0) { try { realKill(p, 'SIGKILL'); } catch {} } }
}

test('ENTER: the fixture really does build a live descendant under the seat pid', async () => {
  // Without this, every "the child died" assertion below is equally true of a
  // fixture whose child never started.
  const sh = spawnTree();
  let kid = null;
  try {
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(alive(sh.pid), 'the fixture shell must be running, or the reap subjects prove nothing');
    kid = childPidOf(sh.pid);
    assert.ok(kid > 0,
      'the fixture shell must have a child of its own — the whole bug is about processes BENEATH the pty, '
      + 'so a flat fixture would pass against a reaper that only ever signalled the root');
  } finally { reapFixture(sh.pid, kid); }
});

test('kill(): a real descendant of the seat pty is dead afterwards', async () => {
  const sh = spawnTree();
  let sleepPid = null;
  try {
    await new Promise((r) => setTimeout(r, 300));
    sleepPid = childPidOf(sh.pid);

    const m = mkManager();
    // The fixture shell stands in for the seat's pty: kill() reaps what is BENEATH
    // it, and `sleep` is beneath it. pty.kill() is a no-op here precisely so the
    // only thing that can kill the sleep is the descendant reap.
    seat(m, 'seat', sh.pid);
    await m.kill('seat');

    assert.ok(await goneWithin(sleepPid, 5000),
      `the seat's descendant (pid ${sleepPid}) survived kill(). This is the measured failure: pty.kill() `
      + 'signals the pty and nothing under it, so a CLI\'s test runner outlives the seat — two were found at '
      + '~98% CPU an hour later, reparented to init, with nothing left to reap them.');
  } finally { reapFixture(sh.pid, sleepPid); }
});

test('archive(): a real descendant of the seat pty is dead afterwards', async () => {
  const sh = spawnTree();
  let sleepPid = null;
  try {
    await new Promise((r) => setTimeout(r, 300));
    sleepPid = childPidOf(sh.pid);

    const m = mkManager();
    seat(m, 'arch', sh.pid);
    await m.archive('arch');

    assert.ok(await goneWithin(sleepPid, 5000),
      `archive()'s descendant (pid ${sleepPid}) survived. archive() carries its own copy of the teardown and `
      + 'must not drift from kill()\'s — an archived seat leaves orphans exactly the same way.');
  } finally { reapFixture(sh.pid, sleepPid); }
});

// ── The ownership guard ──

// A LIVE pid this process does not own, with real descendants beneath it.
//
// TWO shapes, and the second is the one that keeps this honest. `pid: 1` is the
// fixture that took the operator's machine down twice — positive, so every
// sign-based guard passes it, and launchd parents everything. But a subject that
// only ever passes 1 is satisfied by `ptyPid !== 1`, which is a magic value and
// not the invariant: measured, that relaxation shipped GREEN against the
// single-case version of this test while every foreign pid except 1 stayed
// reapable. The 4242/999 row is an ordinary live pid owned by someone else —
// a stale pid the OS has recycled — and nothing but a real ownership proof
// refuses it.
//
// Nothing here reaches the OS: the file-scoped fence records every pid this file
// did not spawn, the 5-second backstop included. A test for a guard against
// killing the machine must not kill the machine when the guard is gone.
const FOREIGN_TREES = [
  {
    what: 'pid 1 (launchd), the shape that took the machine down',
    ptyPid: 1,
    // pid 1 parented to 0, exactly as launchd appears in a real snapshot, with
    // three processes beneath it standing in for the 542 that were really there.
    rows: '1 0 0:01.00\n500 1 0:02.00\n501 1 0:03.00\n502 500 0:04.00\n',
  },
  {
    what: 'an ordinary pid parented to a process that is not us',
    ptyPid: 4242,
    rows: '4242 999 0:01.00\n500 4242 0:02.00\n502 500 0:04.00\n',
  },
];

for (const tree of FOREIGN_TREES) {
  test(`a seat pty this process does not own reaps NOTHING — ${tree.what}`, async () => {
    const warned = [];
    const m = mkManager({ info: () => {}, warn: (_c, msg) => warned.push(String(msg)), error: () => {} });

    const realExecFile = childProcess.execFile;
    signalled = [];
    childProcess.execFile = (file, args, opts, cb) => {
      const done = typeof opts === 'function' ? opts : cb;
      done(null, tree.rows, '');
      return { on() {} };
    };
    try {
      seat(m, 'dummy', tree.ptyPid);
      await m.kill('dummy');
    } finally {
      childProcess.execFile = realExecFile;
    }

    // The pty pid itself is excluded, not overlooked: `pty.kill()` and its
    // 5-second backstop are the seat's OWN pre-existing path and are not what
    // this subject is about. What must be empty is everything BENEATH it.
    assert.deepStrictEqual(signalled.filter((c) => c.pid !== tree.ptyPid), [],
      `the reaper signalled beneath pty pid ${tree.ptyPid}, which this process does not own. pid 1 is launchd: `
      + 'every process on the box is its descendant, and this suite seeds `pty: { pid: 1 }` in dozens of '
      + 'fixtures — it reaped 542 of 543 processes on the operator\'s laptop, twice, during a suite run. But '
      + 'the rule is not about 1: a pty we spawned is ALWAYS a direct child of this process, and any other '
      + 'live pid — a stale one the OS recycled — owns a tree that is equally not ours to kill.');

    assert.ok(warned.some((m2) => /not a child of this one/.test(m2)),
      'the refusal must reach the log. The ~277-process incident was invisible for exactly this reason: a bare '
      + 'catch swallowed it, so nothing said why the desktop had died.');
  });
}

// ENTER: the subject above asserts an ABSENCE, which is equally true of a reaper
// that was never called, a snapshot that never parsed, and a tree with nothing in
// it. This proves the same fixture DOES reap when ownership holds — so the empty
// result above is the guard's doing and not the fixture's.
test('ENTER: the same shape, owned, really does reap — so the refusal above is the guard', async () => {
  const m = mkManager();
  const realExecFile = childProcess.execFile;
  signalled = [];
  childProcess.execFile = (file, args, opts, cb) => {
    const done = typeof opts === 'function' ? opts : cb;
    done(null, `4242 ${process.pid} 0:01.00\n500 4242 0:02.00\n502 500 0:04.00\n`, '');
    return { on() {} };
  };
  try {
    seat(m, 'owned', 4242);
    await m.kill('owned');
  } finally {
    childProcess.execFile = realExecFile;
  }

  assert.deepStrictEqual(signalled.filter((c) => c.pid !== 4242).map((c) => c.pid).sort((a, b) => a - b), [500, 502],
    'an OWNED tree must still be reaped, descendants-of-descendants included. If this is empty the ownership '
    + 'guard is refusing everything and the reaper does nothing at all, which the absence-assertions above '
    + 'cannot distinguish from working correctly.');
});

// ── The broadcast guard ──

const BROADCAST_PIDS = [0, -1, -999];

for (const bad of BROADCAST_PIDS) {
  test(`the reaper refuses a discovered pid of ${bad}, reaps nothing, and logs`, async () => {
    const warned = [];
    const m = mkManager({ info: () => {}, warn: (_c, msg) => warned.push(String(msg)), error: () => {} });

    // Discovery is faked at the `ps` seam so a non-positive pid arrives the only
    // way it could in production — out of the snapshot itself. Recording rather
    // than executing is the fence's doing: if the guard is missing this test must
    // REPORT the broadcast, never perform it on the developer's box.
    const realExecFile = childProcess.execFile;
    signalled = [];
    // The seat pty is parented to OUR pid, not to 1: the ownership guard refuses
    // a tree it does not own before discovery is consulted, so a snapshot that
    // fails ownership would vacuum this subject out — it would pass with nothing
    // signalled, for a reason that has nothing to do with the broadcast guard
    // under test. The bad pid has to arrive from a tree we genuinely own.
    childProcess.execFile = (file, args, opts, cb) => {
      const done = typeof opts === 'function' ? opts : cb;
      done(null, `4242 ${process.pid} 0:01.00\n${bad} 4242 0:02.00\n`, '');
      return { on() {} };
    };
    try {
      seat(m, 'z', 4242);
      await m.kill('z');
    } finally {
      childProcess.execFile = realExecFile;
    }

    assert.deepStrictEqual(signalled.filter((c) => !(c.pid > 0)), [],
      `the reaper passed pid ${bad} to process.kill. Non-positive pids are BROADCASTS, not ids: -1 signals `
      + 'every process the user may signal (this really happened — ~277 processes, three times, through a '
      + 'bare `catch {}`) and 0 signals our own process group. A reaper walks a whole TREE, so it multiplies '
      + 'that blast radius by every pid it discovers. Every discovered pid must go through the `> 0` refusal.');
    assert.ok(warned.some((w) => w.includes('refusing SIGKILL') && w.includes(String(bad))),
      `refusing pid ${bad} must LOG. The incident was invisible for as long as it was because a bare `
      + '`catch {}` swallowed it; a silent refusal is how the next one hides too.');
  });
}

// ── The source shape ──
//
// A runtime fixture cannot prove "no unguarded kill survives anywhere on this
// path": it only exercises the pids it happens to supply. This subject reads the
// source instead, and is the reason the reap was written to hold NO signal call
// of its own — every pid it discovers leaves through `sigkillPid`.

test('the descendant reap signals only through sigkillPid, never process.kill directly', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'session-manager.js'), 'utf8');

  // Comments and strings blanked, offsets preserved: this file's own subject
  // names `process.kill`, and so do the guard comments in the module being
  // scanned. A scan that counted prose would report them.
  let code = '';
  let i = 0;
  while (i < src.length) {
    const two = src.slice(i, i + 2);
    if (two === '//') {
      const end = src.indexOf('\n', i);
      const stop = end < 0 ? src.length : end;
      code += ' '.repeat(stop - i); i = stop;
    } else if (two === '/*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end < 0 ? src.length : end + 2;
      code += ' '.repeat(stop - i); i = stop;
    } else if (src[i] === "'" || src[i] === '"' || src[i] === '`') {
      const q = src[i];
      let j = i + 1;
      while (j < src.length && src[j] !== q) j += src[j] === '\\' ? 2 : 1;
      const stop = Math.min(j + 1, src.length);
      code += ' '.repeat(stop - i); i = stop;
    } else { code += src[i]; i += 1; }
  }

  const body = code.slice(code.indexOf('function reapFromSnapshot'));
  const end = body.indexOf('\n}\n');
  assert.ok(end > 0,
    'could not isolate reapFromSnapshot — it was renamed or reshaped, and this pin is now scanning the wrong '
    + 'text. Re-aim it rather than deleting it.');
  const reap = body.slice(0, end);

  assert.ok(/sigkillPid\(/.test(reap),
    'reapFromSnapshot no longer routes through sigkillPid. That helper IS the `> 0` refusal; a reap that '
    + 'signals any other way has no guard at all, applied across a whole process tree.');

  assert.ok(!/process\s*\.\s*kill\s*\(/.test(reap),
    'reapFromSnapshot calls process.kill directly. Every discovered pid must go through sigkillPid: a '
    + 'non-positive pid is a BROADCAST (-1 = the whole desktop, ~277 processes when this last happened; '
    + '0 = our own process group), and a reaper applies it once per pid in the tree.');

  // The convenient spelling the ticket forbids, checked as a class rather than
  // as one known-bad literal: a group signal is a NEGATED pid, and nothing on
  // this path may ever negate one.
  assert.ok(!/kill\w*\(\s*-/.test(reap),
    'a negated pid appears in reapFromSnapshot. Process GROUPS are never signalled here — discovery returns '
    + 'individual descendant pids and each is targeted individually. A group id would reach processes this '
    + 'seat never spawned.');
});
