'use strict';
// term-exec.test.js — `[agent:term exec]`'s main-side half: the refusals that
// keep a command out of the wrong place, and the settle paths that guarantee an
// agent which asked for a command is ALWAYS told how it ended.
//
// The second half is the reason this file exists at all. Every other failure
// here is loud — a refusal is a message the agent reads immediately. A missing
// settle is silent: the agent waits for a turn that never comes, and nothing in
// any log says so. So the endings are enumerated deliberately (D mark, abandon,
// shell exit, window close, seat close, deadline) and each one is asserted to
// produce exactly one delivery.
//
// Lives beside drawer-pty.test.js rather than inside it: that file pins the tab
// as a terminal (keying, ring, lifecycle), this one pins it as something an
// agent can drive, and the two failure sets have nothing to do with each other.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');

const { createDrawerPtys } = require('../drawer-pty');
const { createMarkParser } = require('../term-marks');
const { vetTermCommand } = require('../drawer-avail');

// Control bytes are built from code points, never typed into this source. A raw
// control character in a test file is invisible, does not survive reformatting,
// and its loss turns an assertion about the write into an assertion about a
// slightly different string that still passes for the wrong reason.
const CTRL_U = String.fromCharCode(0x15);
const CR = String.fromCharCode(0x0d);
const LF = String.fromCharCode(0x0a);
const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const A = `${ESC}]133;A${BEL}`;
const C = (cmd) => `${ESC}]133;C;${b64(cmd)}${BEL}`;
const D = (code) => `${ESC}]133;D;${code}${BEL}`;

function fakePty() {
  const spawned = [];
  const spawn = (file, args, opts) => {
    const proc = {
      file, args, opts,
      pid: 2000 + spawned.length,
      written: [], killed: false,
      _onData: null, _onExit: null,
      onData(fn) { proc._onData = fn; },
      onExit(fn) { proc._onExit = fn; },
      write(d) { if (proc.throwOnWrite) throw new Error(proc.throwOnWrite); proc.written.push(d); },
      resize() {},
      kill() { proc.killed = true; },
      emit(d) { proc._onData(d); },
      exit(code) { proc._onExit({ exitCode: code }); },
    };
    spawned.push(proc);
    return proc;
  };
  spawn.spawned = spawned;
  return spawn;
}

// The dependency names createDrawerPtys actually destructures, read from its
// source. The fixture below is asserted against THIS rather than against a
// hand-copied list: an unwired dep arrives as `undefined`, and undefined is
// legal for every one of them — a missing `vetCommand` silently accepts a
// command with a newline in it, a missing `onExecResult` makes every settle a
// no-op, and both would leave the tests below green while asserting nothing.
function declaredDeps() {
  const src = fs.readFileSync(require.resolve('../drawer-pty.js'), 'utf8');
  const m = src.match(/function createDrawerPtys\(\{([^}]*)\}\)/);
  assert.ok(m, 'ENTER: the destructured parameter list was found');
  return m[1].split(',').map((s) => s.trim().split(':')[0].trim()).filter(Boolean).sort();
}

function mk(over = {}) {
  const spawn = over.spawn || fakePty();
  const sent = [];
  const results = [];   // onExecResult — the agent-facing deliveries
  const passive = [];   // onCommand — the operator's reporting firehose
  const timers = [];

  const deps = {
    spawn,
    send: (id, ch, ...args) => sent.push([id, ch, ...args]),
    shell: '/bin/testsh',
    cwdFor: () => '/tmp/ws',
    scrollbackMax: 64 * 1024,
    env: { PATH: '/usr/bin' },
    log: { info() {}, warn() {}, error() {} },
    // Injected so the two-minute deadline is assertable without waiting two
    // minutes; every timer is captured, including the 5s kill escalation.
    setTimeout: (fn, ms) => {
      const t = { fn, ms, unrefd: false, unref() { t.unrefd = true; return t; } };
      timers.push(t);
      return t;
    },
    killPid: () => {},
    shimEnv: 'shimEnv' in over ? over.shimEnv : (() => ({ ZDOTDIR: '/run/shim' })),
    onCommand: over.onCommand || ((seat, rec) => passive.push([seat, rec])),
    // The REAL parser and the REAL vetter, not stand-ins: the refusals below are
    // claims about what happens with the ones engine.js wires, and a permissive
    // fake would pin a contract nothing ships.
    makeMarkParser: createMarkParser,
    onExecResult: (seat, res) => results.push([seat, res]),
    vetCommand: vetTermCommand,
    execTimeoutMs: over.execTimeoutMs || 120000,
  };
  assert.deepStrictEqual(Object.keys(deps).sort(), declaredDeps(),
    'the fixture must wire EVERY dep — an unwired one is undefined, which is legal and silent');

  return { w: createDrawerPtys(deps), spawn, sent, results, passive, timers };
}

// The kill escalation also uses the injected setTimeout, so a test about the
// exec deadline must not read timers[0] and hope.
const execTimers = (timers) => timers.filter((t) => t.ms !== 5000);

// ── refusals ────────────────────────────────────────────────────────────────
// Every one is checked INSIDE exec() rather than by a caller reading a status
// first: the gap between a check and the write is a foreground program starting,
// and the command then lands in that program's stdin.

test('a seat with no terminal open is refused — exec never spawns one', () => {
  const { w, spawn, results } = mk();
  const r = w.exec('ws-1', 'alice', 'ls');

  assert.deepStrictEqual(r, { ok: false, code: 'no-shell' });
  // The load-bearing half: spawning here would put a shell on the operator's
  // screen they never asked for and run a command in it before they could look.
  assert.strictEqual(spawn.spawned.length, 0, 'nothing was spawned to satisfy the request');
  assert.deepStrictEqual(results, [], 'a synchronous refusal is the answer; nothing is queued');
});

test('a closed window is refused too, not queued against a dead shell', () => {
  const { w, spawn } = mk();
  w.spawn('ws-1', 'alice', {});
  assert.strictEqual(spawn.spawned.length, 1, 'ENTER: the shell existed first');
  w.kill('ws-1');

  assert.deepStrictEqual(w.exec('ws-1', 'alice', 'ls'), { ok: false, code: 'no-shell' });
});

test('the seatless workspace shell is not addressable', () => {
  // It has no parser (nobody to report to), so a command run in it would never
  // settle. Callers derive the seat from the sender, so this guards the module's
  // contract rather than a user-supplied value.
  const { w, spawn } = mk();
  w.spawn('ws-1', null, {});
  assert.deepStrictEqual(w.exec('ws-1', null, 'ls'), { ok: false, code: 'no-seat' });
  assert.deepStrictEqual(spawn.spawned[0].written, [], 'the shared shell was not typed into');
});

test('a command with a newline is refused, and NOTHING is written', () => {
  const { w, spawn } = mk();
  w.spawn('ws-1', 'alice', {});
  const r = w.exec('ws-1', 'alice', `echo one${LF}rm -rf /`);

  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 'bad-command');
  assert.match(r.error, /newline/, 'the refusal names the byte');
  // The whole point of rejecting rather than stripping: the second line is a
  // command the agent did not intend to run, and a strip would have run the
  // first one anyway.
  assert.deepStrictEqual(spawn.spawned[0].written, [], 'not one byte reached the shell');
});

test('an unshimmed shell is refused — a blind command would never report back', () => {
  const { w, spawn, results } = mk({ shimEnv: () => null });
  w.spawn('ws-1', 'alice', {});
  const r = w.exec('ws-1', 'alice', 'ls');

  assert.deepStrictEqual(r, { ok: false, code: 'no-marks' });
  // Refusing is the kind choice: firing anyway would RUN the command and then
  // leave the agent waiting on a D mark that this shell cannot emit.
  assert.deepStrictEqual(spawn.spawned[0].written, [], 'the command did not run');
  assert.deepStrictEqual(results, []);
});

test('the shell remembers whether IT was shimmed, not what the pref says now', () => {
  // The shim is applied at spawn. A pref toggled afterwards must not make exec
  // believe an old shell will report back — that is the third no-marks cause the
  // operator gets told about, and it is only knowable from the shell.
  let on = false;
  const { w } = mk({ shimEnv: () => (on ? { ZDOTDIR: '/run/shim' } : null) });
  w.spawn('ws-1', 'alice', {});
  on = true;

  assert.strictEqual(w._execState('ws-1', 'alice').shimmed, false, 'ENTER: born unshimmed');
  assert.strictEqual(w.exec('ws-1', 'alice', 'ls').code, 'no-marks');
});

test('a busy terminal is refused — the write would land in a program stdin', () => {
  const { w, spawn } = mk();
  w.spawn('ws-1', 'alice', {});
  spawn.spawned[0].emit(C('vim notes.txt'));   // the operator started something

  assert.strictEqual(w._execState('ws-1', 'alice').busy, true, 'ENTER: the parser sees a command open');
  assert.deepStrictEqual(w.exec('ws-1', 'alice', 'ls'), { ok: false, code: 'busy' });
  assert.deepStrictEqual(spawn.spawned[0].written, [], 'nothing was typed into vim');
});

test('a second exec in the same turn is refused as PENDING, not busy', () => {
  // The subtle one, and the reason `pending` is a separate code: between our
  // write and the C mark the shell has not echoed anything back, so the parser
  // is NOT capturing and a bare busy check passes. A second write would type
  // over the first command's line.
  const { w, spawn, results } = mk();
  w.spawn('ws-1', 'alice', {});
  assert.strictEqual(w.exec('ws-1', 'alice', 'first').ok, true, 'ENTER: the first was accepted');
  assert.strictEqual(w._execState('ws-1', 'alice').busy, false,
    'ENTER: the parser is not capturing yet — a busy check alone would let the second through');

  assert.deepStrictEqual(w.exec('ws-1', 'alice', 'second'), { ok: false, code: 'pending', running: 'first' });
  assert.deepStrictEqual(spawn.spawned[0].written, [`${CTRL_U}first${CR}`], 'only the first command was typed');
  assert.deepStrictEqual(results, [], 'and the refusal did not settle the first');
});

test('a write that throws is reported, and leaves the seat able to try again', () => {
  const { w, spawn } = mk();
  w.spawn('ws-1', 'alice', {});
  spawn.spawned[0].throwOnWrite = 'EIO';

  const r = w.exec('ws-1', 'alice', 'ls');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 'write-failed');
  assert.match(r.error, /EIO/);
  // The pending record must be rolled back: leaving it set would make every
  // later exec answer `pending` on a command that never ran.
  assert.strictEqual(w._execState('ws-1', 'alice').pending, null, 'the failed command is not left pending');
});

// ── the accepted write ──────────────────────────────────────────────────────

test('an accepted command is typed as kill-line + command + Enter', () => {
  const { w, spawn } = mk();
  w.spawn('ws-1', 'alice', {});
  const r = w.exec('ws-1', 'alice', '  git status  ');

  // Trimmed by the vetter, and the TRIMMED text is what the caller is told ran —
  // it is also what the pending record and every later message quote.
  assert.deepStrictEqual(r, { ok: true, command: 'git status' });
  // Ctrl-U first: isBusy() false says no command is RUNNING, and says nothing
  // about a half-typed line the operator walked away from. Appending to `rm -rf `
  // would run their fragment and our command as one line.
  assert.deepStrictEqual(spawn.spawned[0].written, [`${CTRL_U}git status${CR}`]);
  assert.deepStrictEqual(w._execState('ws-1', 'alice'), {
    shimmed: true, busy: false, pending: 'git status', timedOut: false,
  });
});

test('exec addresses one seat only', () => {
  const { w, spawn } = mk();
  w.spawn('ws-1', 'alice', {});
  w.spawn('ws-1', 'bob', {});
  w.exec('ws-1', 'bob', 'whoami');

  assert.deepStrictEqual(spawn.spawned[0].written, [], "alice's shell was untouched");
  assert.deepStrictEqual(spawn.spawned[1].written, [`${CTRL_U}whoami${CR}`]);
});

// ── the endings ─────────────────────────────────────────────────────────────

test('the D mark settles the exec with the command that actually ran', () => {
  const { w, spawn, results, passive } = mk();
  w.spawn('ws-1', 'alice', {});
  w.exec('ws-1', 'alice', 'npm test');
  spawn.spawned[0].emit(`${C('npm test')}ok\n${D(0)}${A}`);

  assert.strictEqual(results.length, 1, 'ENTER: exactly one delivery');
  assert.deepStrictEqual(results[0], ['alice', {
    status: 'ok',
    record: { command: 'npm test', exitCode: 0, output: 'ok\n' },
    command: 'npm test',
    late: false,
  }]);
  // `record.command` is what the SHELL reported, which is why it is carried
  // separately from the command we asked for: the operator can edit a line
  // before it runs, and the record is the honest one.
  assert.strictEqual(w._execState('ws-1', 'alice').pending, null, 'the pending record is cleared');
  // Passive reporting is unaffected — the two consumers are independent, and the
  // exec delivery must not swallow the operator's firehose or vice versa.
  assert.strictEqual(passive.length, 1, 'the passive reporter still saw it');
});

test('a passive reporter that throws cannot swallow the exec answer', () => {
  // Ordering claim: settle() runs BEFORE onCommand inside the parser callback.
  // Reversed, one throwing reporter would turn every answered command into a
  // silent hang for the agent that asked.
  const { w, spawn, results } = mk({ onCommand: () => { throw new Error('boom'); } });
  w.spawn('ws-1', 'alice', {});
  w.exec('ws-1', 'alice', 'ls');
  spawn.spawned[0].emit(`${C('ls')}x\n${D(0)}`);

  assert.strictEqual(results.length, 1, 'the agent was still answered');
  assert.strictEqual(results[0][1].status, 'ok');
});

test('an exec answer is delivered even when a reporting pref would drop it', () => {
  // engine.js gates the PASSIVE path on the terminalReporting pref and does not
  // gate this one. The claim pinned here is the seam that makes that possible:
  // the two callbacks are separate, so exec is not reachable from the pref.
  const { w, spawn, results } = mk({ onCommand: () => {} });
  w.spawn('ws-1', 'alice', {});
  w.exec('ws-1', 'alice', 'ls');
  spawn.spawned[0].emit(`${C('ls')}x\n${D(0)}`);
  assert.strictEqual(results.length, 1);
});

test('an abandoned command is reported as abandoned, not left hanging', () => {
  // Ctrl-C at the prompt: zsh redraws (A) and the command never emits a D. This
  // is the case the whole onAbandon signal exists for — before it, the parser
  // dropped the record silently and the agent waited forever.
  const { w, spawn, results } = mk();
  w.spawn('ws-1', 'alice', {});
  w.exec('ws-1', 'alice', 'sleep 900');
  spawn.spawned[0].emit(`${C('sleep 900')}partial\n`);
  assert.strictEqual(results.length, 0, 'ENTER: nothing settled while it was still running');

  spawn.spawned[0].emit(A);
  assert.deepStrictEqual(results, [['alice', {
    status: 'abandoned',
    record: { command: 'sleep 900', output: 'partial\n' },
    command: 'sleep 900',
    late: false,
  }]]);
  // No exitCode anywhere in that payload: there is none, and inventing 130 would
  // claim a SIGINT that may not be what happened.
  assert.ok(!('exitCode' in results[0][1].record), 'an abandoned command has no exit status to report');
});

test('an abandon with no exec pending disturbs nothing', () => {
  // The operator Ctrl-Cs their own command all day. Only a seat that ASKED is
  // owed a message; a delivery here would be noise in the agent's context.
  const { w, spawn, results } = mk();
  w.spawn('ws-1', 'alice', {});
  spawn.spawned[0].emit(`${C('their own thing')}x\n${A}`);
  assert.deepStrictEqual(results, []);
});

test('a shell that exits mid-command says so rather than going quiet', () => {
  const { w, spawn, results } = mk();
  w.spawn('ws-1', 'alice', {});
  w.exec('ws-1', 'alice', 'make');
  spawn.spawned[0].exit(3);

  assert.deepStrictEqual(results, [['alice', {
    status: 'shell-exit', exitCode: 3, command: 'make', late: false,
  }]]);
});

test('a stale shell exiting still answers the command IT was running', () => {
  // The interleaving drawer-pty.js guards with an identity check: an old proc
  // whose child trapped SIGHUP exits after a successor took its key. The
  // successor must not be unmapped — and the settle must still fire, because a
  // waiter on the dead shell's command is owed an answer either way. That is why
  // settle() runs BEFORE the identity guard in onExit.
  const { w, spawn, results } = mk();
  w.spawn('ws-1', 'alice', {});
  const stale = spawn.spawned[0];
  w.exec('ws-1', 'alice', 'make');
  w.kill('ws-1');
  assert.strictEqual(results.length, 1, 'ENTER: the window close already settled it');

  w.spawn('ws-1', 'alice', {});           // successor at the same key
  stale.exit(0);
  assert.strictEqual(results.length, 1, 'the stale exit did not deliver a second answer');
  assert.strictEqual(w._count(), 1, 'and did not unmap the live successor');
});

test('closing the window and closing the tab each name what happened', () => {
  const a = mk();
  a.w.spawn('ws-1', 'alice', {});
  a.w.exec('ws-1', 'alice', 'long-thing');
  a.w.kill('ws-1');
  assert.deepStrictEqual(a.results, [['alice', {
    status: 'shell-gone', reason: 'the workspace window was closed', command: 'long-thing', late: false,
  }]]);

  const b = mk();
  b.w.spawn('ws-1', 'alice', {});
  b.w.exec('ws-1', 'alice', 'long-thing');
  b.w.killSeat('ws-1', 'alice');
  assert.deepStrictEqual(b.results, [['alice', {
    status: 'shell-gone', reason: 'the terminal was closed', command: 'long-thing', late: false,
  }]]);
});

test('two endings for one command deliver ONCE', () => {
  // Legitimately reachable: the operator Ctrl-Cs the command and then closes the
  // window. A second delivery would tell the agent its command ended twice, in
  // two different ways.
  const { w, spawn, results } = mk();
  w.spawn('ws-1', 'alice', {});
  w.exec('ws-1', 'alice', 'sleep 900');
  spawn.spawned[0].emit(`${C('sleep 900')}${A}`);
  assert.strictEqual(results.length, 1, 'ENTER: the abandon settled it');

  w.kill('ws-1');
  assert.strictEqual(results.length, 1, 'the window close was a no-op, not a second answer');
  assert.strictEqual(results[0][1].status, 'abandoned', 'and the FIRST ending is the one reported');
});

test('dispose settles nothing — app quit has nobody left to answer', () => {
  const { w, spawn, results } = mk();
  w.spawn('ws-1', 'alice', {});
  w.exec('ws-1', 'alice', 'sleep 900');
  w.dispose();

  assert.strictEqual(spawn.spawned[0].killed, true, 'ENTER: the shell really was torn down');
  // Every agent that could read the answer is being killed in the same teardown,
  // and on the desktop path this runs inside before-quit — the wrong moment to
  // start appending to a queue nobody will drain.
  assert.deepStrictEqual(results, [], 'no delivery into the void');
});

// ── the deadline ────────────────────────────────────────────────────────────

test('a command that outruns the deadline is reported, and NOT cancelled', () => {
  const { w, spawn, results, timers } = mk({ execTimeoutMs: 30000 });
  w.spawn('ws-1', 'alice', {});
  w.exec('ws-1', 'alice', 'sleep 900');

  const t = execTimers(timers);
  assert.strictEqual(t.length, 1, 'ENTER: a deadline was armed');
  assert.strictEqual(t[0].ms, 30000, 'at the injected timeout, not a hard-coded one');
  // unref'd: a wedged command must never hold the app open at quit.
  assert.strictEqual(t[0].unrefd, true);

  t[0].fn();
  assert.deepStrictEqual(results, [['alice', {
    status: 'timeout', command: 'sleep 900', afterMs: 30000,
  }]]);
  // The command was NOT killed. Killing the operator's foreground process to
  // meet our own deadline would be far worse than a late answer, so the record
  // survives and the eventual D mark still delivers.
  assert.strictEqual(spawn.spawned[0].killed, false, 'nothing was killed to meet the deadline');
  assert.deepStrictEqual(w._execState('ws-1', 'alice'), {
    shimmed: true, busy: false, pending: 'sleep 900', timedOut: true,
  });
});

test('the late result arrives flagged as late, superseding the timeout', () => {
  const { w, spawn, results, timers } = mk({ execTimeoutMs: 30000 });
  w.spawn('ws-1', 'alice', {});
  w.exec('ws-1', 'alice', 'sleep 900');
  execTimers(timers)[0].fn();
  spawn.spawned[0].emit(`${C('sleep 900')}done\n${D(0)}`);

  assert.strictEqual(results.length, 2, 'ENTER: both the deadline notice and the result landed');
  assert.deepStrictEqual(results[1], ['alice', {
    status: 'ok',
    record: { command: 'sleep 900', exitCode: 0, output: 'done\n' },
    command: 'sleep 900',
    // By now the agent has told someone the command outran its deadline. Without
    // this flag the second message reads as a duplicate rather than as the
    // answer that supersedes the first.
    late: true,
  }]);
});

test('a timeout fires at most once for its own command', () => {
  const { w, spawn, results, timers } = mk({ execTimeoutMs: 30000 });
  w.spawn('ws-1', 'alice', {});
  w.exec('ws-1', 'alice', 'sleep 900');
  const t = execTimers(timers)[0];
  t.fn();
  t.fn();
  assert.strictEqual(results.length, 1, 'a re-entered timer does not re-report');
});

test('a stale deadline cannot time out the command that replaced it', () => {
  // The timer is never cleared — drawer-pty requires nothing, so there is no
  // clearTimeout to reach for — it is identity-checked instead. Without that
  // check, the first command's deadline would fire against a second command that
  // is well inside its own.
  const { w, spawn, results, timers } = mk({ execTimeoutMs: 30000 });
  w.spawn('ws-1', 'alice', {});
  w.exec('ws-1', 'alice', 'first');
  const stale = execTimers(timers)[0];
  spawn.spawned[0].emit(`${C('first')}${D(0)}`);
  assert.strictEqual(results.length, 1, 'ENTER: the first command finished normally');

  w.exec('ws-1', 'alice', 'second');
  stale.fn();

  assert.strictEqual(results.length, 1, 'the stale deadline reported nothing');
  assert.deepStrictEqual(w._execState('ws-1', 'alice'), {
    shimmed: true, busy: false, pending: 'second', timedOut: false,
  }, "the second command's own deadline is untouched");
});

test('_execState answers null for a shell that does not exist', () => {
  const { w } = mk();
  assert.strictEqual(w._execState('ws-1', 'nobody'), null);
});
