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
// These assertions can only confirm that the bytes we chose are the bytes we
// send — `spawn` here records writes and has no line editor, so it agrees with
// ANY prefix. It cannot tell you the shell obeys it, and for four rounds it
// happily pinned a sequence a vi-mode zsh typed out as literal text. What the
// prefix has to survive is pinned against a real shell in
// term-exec-keymap.test.js; keep both, they answer different questions.
const CTRL_C = String.fromCharCode(0x03);
const CR = String.fromCharCode(0x0d);
const LF = String.fromCharCode(0x0a);
const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);

// Read from the source, not hand-copied. A duplicated literal that drifts from
// the product's would leak a stale value into `execTimers`, surfacing as an
// unrelated wrong-timer failure somewhere downstream.
const constFromSource = (name) => {
  const src = fs.readFileSync(require.resolve('../drawer-pty.js'), 'utf8');
  const m = src.match(new RegExp(`const ${name} = (\\d+);`));
  assert.ok(m, `ENTER: ${name} was found in drawer-pty.js`);
  return Number(m[1]);
};
const MAX_MS = constFromSource('ABANDON_MAX_MS');
// Read for the same reason as the other one, and it was the one left hand-copied
// as a bare `250` in eight places: `execTimers` EXCLUDES this value, so a drift
// between source and test silently readmits the ack timer to the deadline list
// and surfaces as an unrelated wrong-timer failure downstream.
const ACK_MS = constFromSource('ABANDON_ACK_MS');
// Read for the same reason, and excluded from `execTimers` for the same reason:
// it is another exec-armed timer that is not the settle deadline.
const NUDGE_MS = constFromSource('ABANDON_NUDGE_MS');

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const A = `${ESC}]133;A${BEL}`;
const C = (cmd) => `${ESC}]133;C;${b64(cmd)}${BEL}`;
const D = (code) => `${ESC}]133;D;${code}${BEL}`;
// What a REAL shell emits when a ^C is processed at its prompt, in this order
// and from one precmd: the status first, then the prompt. Measured on zsh and
// bash, in both keymaps, on an empty line and on a half-typed one — 8 rows, all
// `D;130` then `A`, never a bare A.
//
// WHAT IT PROVES IS NARROW: the last command to finish exited 128+SIGINT. It
// does NOT identify WHOSE interrupt. `$?` is latched and the shim re-emits this
// pair on every prompt cycle until a command actually runs — measured, a ^C
// followed by three bare Enters reports 130 all four times, and only running a
// command clears it. So a stale pair can arrive inside our race window, and the
// clocks are what stands behind that. Pinned as a known limitation below.
//
// Kept distinct from `A` throughout this file rather than folded into it: `A`
// alone is a prompt redraw, which is exactly the mark that must NOT release a
// command, so a helper that quietly emitted both would delete the distinction
// these tests exist to pin.
const INTR = `${D(130)}${A}`;
// The whole acknowledgement a real shell gives: some output, then the interrupt
// reporting itself. The fake emits nothing on its own, so tests drive it from
// here — deliberately NOT automatic inside `write()`, since a fixture that acked
// itself would make the two-write split untestable, and the split is the fix.
//
// It emits the bytes as well as the marks, so a test using it exercises both
// halves: the bytes retire the silence deadline, and only the 128+SIGINT report
// releases the command. Bytes alone are not evidence — a ^C is delivered to the
// foreground process group asynchronously with respect to the byte stream, so a
// shell can print a whole quiet prompt with the interrupt still pending.
const ackAbandon = (proc) => {
  proc.emit(`${CR}${LF}$ `);
  proc.emit(INTR);
};

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
  const mirrored = [];  // onOutput/onShellEnd — what a peer watching this seat receives
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
      // Also hung off the pty so a test holding only a proc can still reach the
      // timer list, without every call site having to destructure `timers`.
      if (spawn.spawned) for (const p of spawn.spawned) p.timers = timers;
      return t;
    },
    killPid: () => {},
    shimEnv: 'shimEnv' in over ? over.shimEnv : (() => ({ env: { ZDOTDIR: '/run/shim' }, args: ['-l'] })),
    onCommand: over.onCommand || ((seat, rec) => passive.push([seat, rec])),
    // The REAL parser and the REAL vetter, not stand-ins: the refusals below are
    // claims about what happens with the ones engine.js wires, and a permissive
    // fake would pin a contract nothing ships.
    makeMarkParser: createMarkParser,
    onExecResult: (seat, res) => results.push([seat, res]),
    vetCommand: vetTermCommand,
    execTimeoutMs: over.execTimeoutMs || 120000,
    // The peer-terminal taps (t219). Captured rather than stubbed to no-ops so
    // a test can assert that a remote viewer sees the SAME bytes the local tab
    // does — the shared-shell property the peer terminal rests on.
    onOutput: (seat, data) => mirrored.push([seat, data]),
    onShellEnd: (seat, code) => mirrored.push([seat, { exit: code }]),
  };
  assert.deepStrictEqual(Object.keys(deps).sort(), declaredDeps(),
    'the fixture must wire EVERY dep — an unwired one is undefined, which is legal and silent');

  return { w: createDrawerPtys(deps), spawn, sent, results, passive, mirrored, timers };
}

// The kill escalation also uses the injected setTimeout, so a test about the
// exec deadline must not read timers[0] and hope.
// The deadline timers, by EXCLUDING every other timer the code arms (the 5s kill
// escalation and the three abandon-handshake clocks) rather than by taking [0].
// Positional indexing broke silently when the ack timer was added — it is armed
// first, so `[0]` became the wrong timer and tests asserting a timeout were
// firing an arm instead. Every caller below indexes into this, so a pattern that
// admits an extra row does not fail here; it fails somewhere downstream that
// looks unrelated. A new handshake clock must be excluded here in the same
// commit that arms it, for that reason.
const execTimers = (timers) => timers.filter(
  (t) => t.ms !== 5000 && t.ms !== ACK_MS && t.ms !== NUDGE_MS && t.ms !== MAX_MS);

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
  const { w } = mk({ shimEnv: () => (on ? { env: { ZDOTDIR: '/run/shim' }, args: ['-l'] } : null) });
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
  ackAbandon(spawn.spawned[0]);
  assert.strictEqual(w._execState('ws-1', 'alice').busy, false,
    'ENTER: the parser is not capturing yet — a busy check alone would let the second through');

  assert.deepStrictEqual(w.exec('ws-1', 'alice', 'second'), { ok: false, code: 'pending', running: 'first' });
  assert.deepStrictEqual(spawn.spawned[0].written, [CTRL_C, `first${CR}`], 'only the first command was typed');
  assert.deepStrictEqual(results, [], 'and the refusal did not settle the first');
});

// ── the abandon/type split ──────────────────────────────────────────────────
// ^C is a SIGNAL, and a shell discards pending input when SIGINT lands. Bytes
// sharing that write can go with it: measured against real bash at 3 failures in
// 72 under load, producing `cho: command not found` — a truncated command that
// still RUNS. `rm -rf ./buil` is a valid command, not an error, which is why
// this is pinned harder than the keymap choice it replaced.

test('the command is not typed until the shell has answered the abandon', () => {
  const { w, spawn, results } = mk();
  w.spawn('ws-1', 'alice', {});
  assert.strictEqual(w.exec('ws-1', 'alice', 'ls').ok, true, 'ENTER: accepted');

  assert.deepStrictEqual(spawn.spawned[0].written, [CTRL_C],
    'only the abandon has gone out — the command is still held back');
  assert.strictEqual(w._execState('ws-1', 'alice').pending, 'ls',
    'ENTER: and it is pending, so a second exec is still refused while we wait');

  ackAbandon(spawn.spawned[0]);
  assert.deepStrictEqual(spawn.spawned[0].written, [CTRL_C, `ls${CR}`],
    'the shell reported its interrupt, so the command follows as its own write');
  assert.deepStrictEqual(results, [], 'and typing it settles nothing on its own');
});

// The three tests below pin BYTES RELEASE NOTHING. The tests around them pass
// against an arm that types on the first byte, or on a quiet window after it, so
// without these a revert to either would be caught by nothing but a rare
// real-shell flake.

test('a first byte is not evidence — the command is not typed on shell output', () => {
  // The bytes that arrive first are the ones ALREADY IN FLIGHT when the ^C
  // landed: a prior command's echo, an OSC 7 cwd report. They are not an answer
  // to the signal, and typing on them puts the command inside the input discard,
  // which drops characters out of its MIDDLE and still runs the remainder.
  const { w, spawn } = mk();
  w.spawn('ws-1', 'alice', {});
  w.exec('ws-1', 'alice', 'ls');

  spawn.spawned[0].emit(`${CR}${LF}$ `);
  assert.deepStrictEqual(spawn.spawned[0].written, [CTRL_C],
    'the shell has spoken, which is not evidence its interrupt was processed');
});

test('NO amount of shell output releases the command — bytes arm no timer', () => {
  // The falsification for the second half of this ticket, and the one the
  // captured failure needed. What used to be here was a 60ms quiet window: any
  // byte armed it, and once the shell stopped talking for that long the command
  // was typed. That is what fired in the reproduction — no prompt mark had been
  // seen at all, the silence deadline was already inert, and the cap was still
  // 900ms away.
  //
  // It could not be repaired by widening: a ^C is consumed by the tty line
  // discipline as a SIGNAL to the foreground process group and delivered
  // asynchronously with respect to the byte stream, so a shell can emit a
  // complete, quiet, line-editor-ready prompt while the interrupt is still
  // pending. "Quiet for N ms" is a fact about the wire; the question is about a
  // signal. So the assertion is not "a longer window" but "no window at all".
  //
  // Asserted on the TIMER LIST rather than only on the writes, because those are
  // different claims: a window that is armed but never fired in this test would
  // satisfy `written` and still be the defect, waiting to fire under a real
  // clock. The only timers an exec may arm are the silence deadline, the cap,
  // and the two-minute settle deadline.
  const { w, spawn, timers } = mk();
  w.spawn('ws-1', 'alice', {});
  w.exec('ws-1', 'alice', 'ls');
  const proc = spawn.spawned[0];
  const armedByExec = timers.length;

  // A prompt repaint, arriving in pieces, exactly as a real shell sends one.
  for (const chunk of [`${CR}${LF}`, '$ ', '\x1b[K', '\x1b[?2004h']) proc.emit(chunk);
  assert.deepStrictEqual(proc.written, [CTRL_C],
    'a whole prompt repaint types nothing — none of it is evidence about the signal');
  assert.strictEqual(timers.length, armedByExec,
    'and not one byte armed a timer, so there is no window left to fire later');

  // Every timer the exec DID arm, fired: still nothing but the cap may type,
  // and only because it is the deliberate backstop.
  const silence = timers.filter((t) => t.ms === ACK_MS);
  assert.strictEqual(silence.length, 1, 'ENTER: the silence deadline was armed');
  silence[0].fn();
  assert.deepStrictEqual(proc.written, [CTRL_C],
    'the silence deadline is inert once the shell has spoken');
});

// The SWALLOWED FIRST BYTE, driven deterministically. This reproduced only
// under machine contention before — 8+ occurrences over four days across two
// shells, two keymaps and four agents, always one red row in an otherwise green
// suite, and it cost at least one false review rejection. Nothing here depends
// on load or timing: the interleaving is driven through the injected timer seam,
// so it either holds on every run or fails on every run.
//
// The defect it records: `execArm` was fed by RAW BYTES, which cannot
// distinguish output caused by our ^C from output already in flight when we
// wrote it. Under load the quiet window elapsed over pre-^C bytes while the
// signal was still queued, the command was typed, and THEN SIGINT landed and
// discarded it — taking the head of the command with it. `cho a; echo b` from
// `echo a; echo b`. Bytes now release nothing, so this pins the mark path.
test('a prompt mark types the command — raw bytes never do', () => {
  const { w, spawn } = mk();
  w.spawn('ws-1', 'alice', {});
  w.exec('ws-1', 'alice', 'ls');
  const proc = spawn.spawned[0];

  // Pre-^C output: a prior command's tail, still in flight when the signal was
  // written. Under the byte-only handshake this armed a window and, 60ms later,
  // typed into a shell that had not yet processed the interrupt.
  proc.emit(`${CR}${LF}`);
  assert.deepStrictEqual(proc.written, [CTRL_C],
    'ENTER: still held back — raw bytes are not evidence about the signal');

  // The interrupt's own prompt mark: precmd reporting 130, then the prompt. The
  // interrupt has been processed and the line editor is ready, so it types
  // WITHOUT waiting out the window — the window was only ever estimating this.
  proc.emit(INTR);
  assert.deepStrictEqual(proc.written, [CTRL_C, `ls${CR}`],
    'the mark is a positive acknowledgement and types immediately');
});

// ── the ack's IDENTITY ──────────────────────────────────────────────────────
// The mark that releases the command has to be OUR interrupt's, and the three
// tests below are the falsification: each delivers an A that cannot be shown to
// postdate the ^C and asserts nothing is typed.
//
// The failure they encode was captured whole (a 1-in-132 red in the keymap file,
// preserved beside this ticket): the shell executed `cho TERMEXEC_RAN` and the
// prompt before it exited 130. Nothing was swallowed and nothing was doubled —
// the command was SPLIT across the interrupt boundary. `e` echoed onto the old
// line, the ^C then killed that line, and the remainder ran on the fresh prompt
// as a shorter command that was still valid. A truncated `rm -rf ./buil` runs
// too, which is why this is pinned rather than tuned.
//
// Why a status and not a count. The number of prompt redraws before a shell
// processes an interrupt is set by the operator's theme and is unbounded — a
// segment waiting on a network call can redraw arbitrarily late. So "ignore the
// first N" cannot be made safe at any N. A status is not a proof of ownership
// either (see INTR), but it is a fact the shell reports about itself rather than
// a number we guessed, and what it filters out is every prompt that is only a
// redraw.

test('a bare prompt mark does not type — a redraw is not our interrupt', () => {
  // The async prompt redraw. The operator's theme repaints (a git or cloud
  // segment resolving, a SIGWINCH), which emits a prompt mark of its own while
  // our ^C is still queued in the pty and unprocessed. Releasing on it types
  // onto the line the interrupt is about to kill.
  const { w, spawn, timers } = mk();
  w.spawn('ws-1', 'alice', {});
  w.exec('ws-1', 'alice', 'ls');
  const proc = spawn.spawned[0];

  proc.emit(A);
  assert.deepStrictEqual(proc.written, [CTRL_C],
    'a prompt mark carrying no interrupt status is not evidence our ^C was processed');

  // Rejecting the impostor must not WEDGE the exec: a guard that refuses the
  // mark and then never types trades a rare corruption for a permanent hang,
  // which is worse. The cap is what carries it, and asserting that here is what
  // makes this test about a filter rather than about a refusal.
  timers.filter((t) => t.ms === MAX_MS)[0].fn();
  assert.deepStrictEqual(proc.written, [CTRL_C, `ls${CR}`],
    'the command still goes out on the cap — rejected, not wedged');
});

// ── the NUDGE ───────────────────────────────────────────────────────────────
// This state — the shell spoke, drew a prompt, and none of it carried an
// interrupt status — is where every measured corruption happened. Correlated
// over 256 execs against a real bash at 32 concurrent shells: all 254 that saw
// an interrupt-acked prompt after the ^C arrived intact, and both that saw none
// lost their leading byte. The predictor is the MISSING PROMPT, not the elapsed
// time, which is why the repair is a second signal rather than a longer wait —
// a fixed 3s gap between the two writes still lost the byte 2 times in 192.

test('a shell that spoke without acking is re-abandoned, not typed into', () => {
  const { w, spawn, timers } = mk();
  w.spawn('ws-1', 'alice', {});
  w.exec('ws-1', 'alice', 'ls');
  const proc = spawn.spawned[0];

  // A prompt that is only a redraw: the shell is talking, but nothing it said is
  // evidence our interrupt was processed.
  proc.emit(A);
  assert.deepStrictEqual(proc.written, [CTRL_C], 'ENTER: still held back at the filter');

  timers.filter((t) => t.ms === NUDGE_MS)[0].fn();
  assert.deepStrictEqual(proc.written, [CTRL_C, CTRL_C],
    'the nudge repeats the abandon — it must not type the command here');

  // And the prompt cycle it elicits releases the command through the ORDINARY
  // promptAck path. That is the whole point: the nudge adds no release path, it
  // makes the existing one reachable in the state that used to type blind.
  proc.emit(INTR);
  assert.deepStrictEqual(proc.written, [CTRL_C, CTRL_C, `ls${CR}`],
    'the elicited interrupt mark types the command, so the cap is never reached');
});

test('a SILENT shell is never nudged — it has already been typed into', () => {
  // The other arm, and the one where a second ^C would be actively harmful: the
  // silence deadline fires first and types the command, so re-abandoning after
  // it would interrupt the command we just sent rather than an abandoned line.
  const { w, spawn, timers } = mk();
  w.spawn('ws-1', 'alice', {});
  w.exec('ws-1', 'alice', 'ls');
  const proc = spawn.spawned[0];

  timers.filter((t) => t.ms === ACK_MS)[0].fn();
  assert.deepStrictEqual(proc.written, [CTRL_C, `ls${CR}`],
    'ENTER: the silent shell was typed into by the ack deadline');

  timers.filter((t) => t.ms === NUDGE_MS)[0].fn();
  assert.deepStrictEqual(proc.written, [CTRL_C, `ls${CR}`],
    'the nudge writes nothing — a ^C here would kill the command that just went out');
});

test('the nudge fires ONCE and never after the command has gone out', () => {
  // A retry loop would keep signalling a foreground program that is legitimately
  // slow to die; ABANDON_MAX_MS is the escape hatch, not repetition. Both guards
  // are exercised: firing the same timer twice, and firing it after the cap has
  // already typed.
  const { w, spawn, timers } = mk();
  w.spawn('ws-1', 'alice', {});
  w.exec('ws-1', 'alice', 'ls');
  const proc = spawn.spawned[0];

  proc.emit(A);
  const nudge = timers.filter((t) => t.ms === NUDGE_MS)[0];
  nudge.fn();
  nudge.fn();
  assert.deepStrictEqual(proc.written, [CTRL_C, CTRL_C], 'one repeat, not two');

  timers.filter((t) => t.ms === MAX_MS)[0].fn();
  assert.deepStrictEqual(proc.written, [CTRL_C, CTRL_C, `ls${CR}`],
    'ENTER: the cap still carries a shell that never acked either signal');

  nudge.fn();
  assert.deepStrictEqual(proc.written, [CTRL_C, CTRL_C, `ls${CR}`],
    'and a late nudge cannot signal the command the cap just sent');
});

test('the nudge cannot signal a LATER exec', () => {
  // Same identity hazard the typing path guards: by the time this fires, the
  // exec that armed it may be settled and a second one running. A ^C then lands
  // on a command this exec does not own.
  const { w, spawn, timers, results } = mk();
  w.spawn('ws-1', 'alice', {});
  w.exec('ws-1', 'alice', 'first');
  const proc = spawn.spawned[0];
  proc.emit(A);
  const nudge = timers.filter((t) => t.ms === NUDGE_MS)[0];

  // The first command runs and ends, so the seat is free for a second exec.
  proc.emit(`${INTR}`);
  proc.emit(`${C('first')}${D(0)}${A}`);
  assert.strictEqual(results.length, 1, 'ENTER: the first exec settled');
  assert.strictEqual(w.exec('ws-1', 'alice', 'second').ok, true, 'ENTER: a second was accepted');
  const before = proc.written.slice();

  nudge.fn();
  assert.deepStrictEqual(proc.written, before,
    "the stale nudge writes nothing — a ^C here would abandon the second exec's line");
});

test('a prompt mark whose status is NOT an interrupt does not type', () => {
  // The same shape with the status present and wrong: the previous command
  // finished normally and its precmd drew a prompt while our signal was still
  // in flight. `D;0` says a command ended well — it says nothing about a SIGINT,
  // and treating any D+A pair as the acknowledgement would readmit the whole
  // race under a longer name.
  const { w, spawn } = mk();
  w.spawn('ws-1', 'alice', {});
  w.exec('ws-1', 'alice', 'ls');
  const proc = spawn.spawned[0];

  proc.emit(`${D(0)}${A}`);
  assert.deepStrictEqual(proc.written, [CTRL_C],
    'a prompt reporting a clean exit is filtered out — only 128+SIGINT passes');

  // And the real one still works afterwards — the guard rejects the impostor
  // without wedging the exec, which would trade a rare corruption for a hang.
  proc.emit(INTR);
  assert.deepStrictEqual(proc.written, [CTRL_C, `ls${CR}`],
    'the interrupt mark that follows still releases the command');
});

// KNOWN LIMITATION, PINNED DELIBERATELY. This test asserts the CURRENT
// behaviour, and that behaviour is a race we chose not to close — read it as a
// record of the gap, not as a property worth preserving.
//
// `$?` is latched: after any interrupt the shim re-emits `D;130` then `A` on
// every prompt cycle until a command actually runs. Measured on real zsh and
// bash — a ^C followed by three bare Enters reports 130 all four times, and
// only running `true` clears it to 0. So a pair that has nothing to do with our
// ^C can arrive after we write it (the operator pressing Enter is enough) and
// releases the command exactly as the real acknowledgement would.
//
// Nothing in this file distinguished those two cases before, and that absence is
// what let "a token that cannot predate the signal" stand in the prose for two
// rounds. The claim was only ever measured in the direction ^C -> 130; it was
// never measured 130 -> ^C.
//
// NOT closed on purpose: the only fix that would work is refusing the fast path
// whenever a 130 is ambiguous, which means paying the silence deadline on every
// exec that follows an interrupt, to buy a window the clocks already backstop.
// A shim-side nonce could close it properly; that is a larger change than this
// ticket, and the clocks make it a latency question rather than a correctness
// one.
test('a STALE interrupt status still releases the command — the residual race', () => {
  const { w, spawn } = mk();
  w.spawn('ws-1', 'alice', {});
  w.exec('ws-1', 'alice', 'ls');
  const proc = spawn.spawned[0];
  assert.deepStrictEqual(proc.written, [CTRL_C],
    'ENTER: our ^C is out and unprocessed — nothing typed yet');

  // A prompt cycle that is NOT our interrupt's: the latch re-reporting an older
  // 130. Indistinguishable from the real reply on arrival, which is the point.
  proc.emit(INTR);
  assert.deepStrictEqual(proc.written, [CTRL_C, `ls${CR}`],
    'the stale pair releases the command — the residual window this fix does NOT close');
});

test('an interrupt status does not carry across an intervening prompt', () => {
  // The status is only good for the A that belongs to it. A `130` left standing
  // would make the NEXT unrelated redraw look like an interrupt's — the same
  // defect one prompt later, and the one a naive "remember we saw 130" would
  // introduce. Both marks arrive here in one read, which is how a real shell
  // sends them: measured 30/30 prompt cycles on zsh and bash, D and A never
  // split across reads.
  const { w, spawn } = mk();
  w.spawn('ws-1', 'alice', {});
  const proc = spawn.spawned[0];

  // An interrupt BEFORE our exec — the operator's own ^C, its 130 already in
  // the stream when we write ours.
  proc.emit(INTR);
  w.exec('ws-1', 'alice', 'ls');
  assert.deepStrictEqual(proc.written, [CTRL_C],
    'ENTER: our signal is out and nothing is typed yet — the stale 130 predates it');

  proc.emit(A);
  assert.deepStrictEqual(proc.written, [CTRL_C],
    'the earlier interrupt does not vouch for this prompt');
});

test('the command is typed exactly once when the mark AND the clocks both fire', () => {
  // The clocks are retained as the backstop, so both paths stay live on a
  // shell that emits marks. A second copy would run the command twice — and a
  // duplicated `rm -rf` is not a cosmetic defect.
  const { w, spawn, timers } = mk();
  w.spawn('ws-1', 'alice', {});
  w.exec('ws-1', 'alice', 'ls');
  const proc = spawn.spawned[0];

  proc.emit(INTR);
  assert.deepStrictEqual(proc.written, [CTRL_C, `ls${CR}`], 'ENTER: the mark typed it');

  timers.filter((t) => t.ms === ACK_MS)[0].fn();
  timers.filter((t) => t.ms === MAX_MS)[0].fn();
  assert.deepStrictEqual(proc.written, [CTRL_C, `ls${CR}`],
    'every later clock is a no-op — the command went out once');
});

test('a shell that sends no marks still gets its command, on the cap', () => {
  // Not hypothetical, and it is the reason the cap must stay unconditional: a
  // profile that aborts before the hooks install, or clobbers precmd after ours
  // is prepended, leaves a shell that was born shimmed and never reports an
  // interrupt. A mark-only wait would hang every one of those to EXEC_TIMEOUT.
  //
  // It now waits out the CAP rather than a 60ms window, which is the cost of the
  // fix and is stated plainly: this shell's command goes out later than it used
  // to. Later is the correct direction — the window it replaced was typing
  // before the interrupt had landed.
  const { w, spawn, timers } = mk();
  w.spawn('ws-1', 'alice', {});
  w.exec('ws-1', 'alice', 'ls');
  const proc = spawn.spawned[0];

  proc.emit(`${CR}${LF}$ `);
  assert.deepStrictEqual(proc.written, [CTRL_C], 'ENTER: no mark, so nothing typed yet');
  const cap = timers.filter((t) => t.ms === MAX_MS);
  assert.strictEqual(cap.length, 1, 'ENTER: exactly one cap, armed once per exec');
  cap[0].fn();
  assert.deepStrictEqual(proc.written, [CTRL_C, `ls${CR}`],
    'the cap still delivers for a shell that never marks its prompt');
});

// One A does two things — it abandons an open command and it acks a pending
// exec's ^C — and term-marks.js runs them in that order. Nothing pinned it, and
// swapping the two blocks kills no other test. Reversed, the ack types the
// command onto a shell whose waiter is about to be told `abandoned`: the command
// RUNS, owned by nobody, and its D comes back `mismatch`. A silent wrong answer,
// which is the worst shape available here.
// The interleaving that reaches it: our ^C is out and the ack is still ARMED
// (the command has not been typed yet), and in that window the operator's own
// command opens with a C. The A that follows is their interrupt. Correct order
// settles ours as abandoned FIRST, so the ack's `rec.pending !== p` guard finds
// the record already cleared and types nothing.
//
// A command already typed cannot show this: typeCommand releases the ack on its
// way out, so there is nothing left to misfire and the two orders agree. That
// is why this test waits before letting the command go — an earlier version of
// it acked first and passed against BOTH orderings, pinning nothing.
test('an A that abandons an open command does not also type the pending one', () => {
  const { w, spawn, results } = mk();
  w.spawn('ws-1', 'alice', {});
  assert.strictEqual(w.exec('ws-1', 'alice', 'sleep 900').ok, true, 'ENTER: accepted');
  const proc = spawn.spawned[0];
  assert.deepStrictEqual(proc.written, [CTRL_C],
    'ENTER: only the abandon is out — the ack is still armed, which is what makes the order matter');

  // The operator's own command, racing our handshake: it opens the parser, so
  // the A below is an abandon and not merely a prompt.
  proc.emit(C('vim notes.txt'));
  proc.emit(A);

  assert.deepStrictEqual(results.map(([, r]) => r.status), ['abandoned'],
    'our pending exec is settled abandoned, exactly once');
  assert.deepStrictEqual(proc.written, [CTRL_C],
    'and the command is NOT typed — acking first would run it unowned, and its D would come back mismatched');
});

test('a prompt mark types the SECOND command once, not the first one again', () => {
  // A shell redraws its prompt constantly, so marks keep arriving long after the
  // exec that was waiting for one. This pins the observable property — one copy
  // of the command that is actually pending.
  //
  // It does NOT pin the ack's release in typeCommand: `armed` already makes a
  // stale ack a no-op, so this stays green with that line deleted (checked by
  // mutation). The release is closure hygiene and has no test of its own,
  // deliberately — a test asserting a behaviour two mechanisms guarantee tells
  // you nothing about which one is working.
  const { w, spawn, timers } = mk();
  w.spawn('ws-1', 'alice', {});
  w.exec('ws-1', 'alice', 'first');
  const proc = spawn.spawned[0];

  proc.emit(INTR);
  assert.deepStrictEqual(proc.written, [CTRL_C, `first${CR}`], 'ENTER: the first command went out');
  // Settle it so the seat is free, then start a second command.
  proc.emit(C('first'));
  proc.emit(D(0));
  proc.written.length = 0;
  assert.strictEqual(w.exec('ws-1', 'alice', 'second').ok, true, 'ENTER: a second exec was accepted');

  // A prompt mark now belongs to the SECOND command's handshake only. If the
  // first exec's ack were still wired, this would type `second` twice.
  proc.emit(INTR);
  assert.deepStrictEqual(proc.written, [CTRL_C, `second${CR}`],
    'exactly one copy — the first exec released its ack when it typed');
});

test('a shell that talks without pause still gets its command, on the cap', () => {
  // Reachable without any misbehaviour: isBusy() is false while a BACKGROUND
  // job writes to the tty, so exec() is accepted and the ^C is delivered. This
  // shell emits no interrupt mark and never stops talking, so the cap is the
  // only thing that types; without it the waiter would hang to EXEC_TIMEOUT,
  // reporting a timeout for a command that never ran.
  const { w, spawn, timers } = mk();
  w.spawn('ws-1', 'alice', {});
  w.exec('ws-1', 'alice', 'ls');

  for (let i = 0; i < 50; i++) spawn.spawned[0].emit('chatter ');
  assert.deepStrictEqual(spawn.spawned[0].written, [CTRL_C],
    'ENTER: a shell talking without pause has not been typed to yet');

  const cap = timers.filter((t) => t.ms === MAX_MS);
  assert.strictEqual(cap.length, 1, 'ENTER: exactly one cap, armed once per exec');
  cap[0].fn();
  assert.deepStrictEqual(spawn.spawned[0].written, [CTRL_C, `ls${CR}`],
    'the cap types it regardless of how chatty the shell is');

  // A STRUCTURAL GUARD, and it passes vacuously today: `arm()` cannot schedule
  // anything, so no byte could arm a timer whether the command is out or not.
  // Kept as the tripwire for the byte-arm returning — a reintroduced per-chunk
  // window would fire here even if it were careful about the already-typed case.
  // The line that actually holds the property is the timer-count assertion in
  // 'NO amount of shell output releases the command', which checks it while the
  // command is still PENDING and is where a real regression would land first.
  const before = timers.length;
  spawn.spawned[0].emit('more chatter');
  assert.strictEqual(timers.length, before, 'no further timers are armed after the command is typed');
});

test('the silence deadline is inert once the shell has spoken', () => {
  // Both clocks are armed up front, so the 250ms deadline is still in the list
  // after an answer arrives. It covers a shell that says NOTHING; one that has
  // spoken is no longer that shell, and firing anyway would type on a schedule
  // that no longer describes it.
  const { w, spawn, timers } = mk();
  w.spawn('ws-1', 'alice', {});
  w.exec('ws-1', 'alice', 'ls');

  spawn.spawned[0].emit(`${CR}${LF}$ `);
  const silence = timers.filter((t) => t.ms === ACK_MS);
  assert.strictEqual(silence.length, 1, 'ENTER: the silence deadline was armed');
  silence[0].fn();
  assert.deepStrictEqual(spawn.spawned[0].written, [CTRL_C],
    'the deadline handed ownership to the cap and types nothing itself');
});

test('a shell that answers nothing still gets its command, on the fallback', () => {
  // ^C on an already-empty line under a prompt that does not redraw. Waiting
  // forever would be a command that never runs and an agent that never hears
  // back — the one outcome this module exists to prevent.
  const { w, spawn, timers } = mk();
  w.spawn('ws-1', 'alice', {});
  w.exec('ws-1', 'alice', 'ls');
  assert.deepStrictEqual(spawn.spawned[0].written, [CTRL_C], 'ENTER: still held back');

  const arm = timers.filter((t) => t.ms === ACK_MS);
  assert.strictEqual(arm.length, 1, 'ENTER: a fallback was armed');
  arm[0].fn();
  assert.deepStrictEqual(spawn.spawned[0].written, [CTRL_C, `ls${CR}`]);
});

test('the command is typed exactly once when the shell answers AND the fallback fires', () => {
  const { w, spawn, timers } = mk();
  w.spawn('ws-1', 'alice', {});
  w.exec('ws-1', 'alice', 'ls');
  ackAbandon(spawn.spawned[0]);
  assert.deepStrictEqual(spawn.spawned[0].written, [CTRL_C, `ls${CR}`], 'ENTER: the ack typed it');

  timers.filter((t) => t.ms === ACK_MS)[0].fn();
  assert.deepStrictEqual(spawn.spawned[0].written, [CTRL_C, `ls${CR}`],
    'the late fallback is a no-op — a second copy would run the command twice');

  // Nor does any LATER byte retype it: the arm is consumed, not merely guarded.
  spawn.spawned[0].emit('unrelated output');
  assert.deepStrictEqual(spawn.spawned[0].written, [CTRL_C, `ls${CR}`]);
});

test('a command settled before it was typed is never typed', () => {
  // The window closes between the abandon and the ack. Without this the arm
  // fires into a shell whose waiter has already been told the command is over —
  // and after a same-seat respawn, onto a fresh shell's command line.
  const { w, spawn, results } = mk();
  w.spawn('ws-1', 'alice', {});
  w.exec('ws-1', 'alice', 'ls');
  assert.deepStrictEqual(spawn.spawned[0].written, [CTRL_C], 'ENTER: not yet typed');

  w.killSeat('ws-1', 'alice');
  assert.strictEqual(results.length, 1, 'ENTER: the waiter was answered by the kill');

  ackAbandon(spawn.spawned[0]);
  assert.deepStrictEqual(spawn.spawned[0].written, [CTRL_C],
    'the settled command was never typed');
  assert.strictEqual(results.length, 1, 'and nothing was delivered twice');
});

test('a stale fallback cannot type its command onto a LATER command line', () => {
  // The case a clear-on-settle cannot reach, which is why the arm is identity
  // checked at the point of use instead: this timer was already dispatched, so
  // its closure exists whatever the record now holds. It fires after the first
  // command has ended and a second is mid-abandon — typing here would put `one`
  // on `two`'s line, and `two`'s waiter would receive `one`'s output as its
  // answer.
  const { w, spawn, results, timers } = mk();
  w.spawn('ws-1', 'alice', {});
  w.exec('ws-1', 'alice', 'one');
  const staleArm = timers.filter((t) => t.ms === ACK_MS)[0];
  assert.ok(staleArm, 'ENTER: the first command armed a fallback');

  ackAbandon(spawn.spawned[0]);
  spawn.spawned[0].emit(C('one'));
  spawn.spawned[0].emit(D(0));
  assert.strictEqual(results.length, 1, 'ENTER: the first command is over');

  assert.strictEqual(w.exec('ws-1', 'alice', 'two').ok, true, 'ENTER: a second was accepted');
  const written = spawn.spawned[0].written.length;
  staleArm.fn();
  assert.strictEqual(spawn.spawned[0].written.length, written,
    'the stale fallback wrote nothing');
  assert.deepStrictEqual(spawn.spawned[0].written.slice(-2), [`one${CR}`, CTRL_C],
    'the last writes are the first command and the second abandon — no `one` after it');
});

test('a throw when the command is typed reaches the waiter', () => {
  // exec() has already returned `ok` by then, so a thrown write here would
  // otherwise be a command the agent is told is running and never hears about.
  const { w, spawn, results } = mk();
  w.spawn('ws-1', 'alice', {});
  w.exec('ws-1', 'alice', 'ls');
  spawn.spawned[0].throwOnWrite = 'EIO';
  ackAbandon(spawn.spawned[0]);

  assert.strictEqual(results.length, 1, 'ENTER: the waiter was answered');
  assert.strictEqual(results[0][1].status, 'write-failed');
  assert.match(results[0][1].reason, /EIO/);
  assert.strictEqual(w._execState('ws-1', 'alice').pending, null,
    'and the seat is usable again rather than wedged on a command that never ran');
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

test('an accepted command is typed as kill-line + kill-to-EOL + command + Enter', () => {
  const { w, spawn } = mk();
  w.spawn('ws-1', 'alice', {});
  const r = w.exec('ws-1', 'alice', '  git status  ');

  // Trimmed by the vetter, and the TRIMMED text is what the caller is told ran —
  // it is also what the pending record and every later message quote.
  assert.deepStrictEqual(r, { ok: true, command: 'git status' });
  // TWO writes, and the split is the assertion. isBusy() false says no command
  // is RUNNING, and says nothing about a half-typed line the operator walked
  // away from — appending to `rm -rf ` would run their fragment and our command
  // as one line. The abandon goes out alone and the command follows only once
  // the shell has answered, because SIGINT discards input arriving with it: a
  // single write drops the command's first byte under load, which runs a
  // DIFFERENT command rather than failing. Which bytes clear the line under
  // which keymap is pinned against real shells in term-exec-keymap.test.js —
  // this fixture records writes and cannot tell you.
  ackAbandon(spawn.spawned[0]);
  assert.deepStrictEqual(spawn.spawned[0].written, [CTRL_C, `git status${CR}`]);
  assert.deepStrictEqual(w._execState('ws-1', 'alice'), {
    shimmed: true, busy: false, pending: 'git status', timedOut: false,
  });
});

test('exec addresses one seat only', () => {
  const { w, spawn } = mk();
  w.spawn('ws-1', 'alice', {});
  w.spawn('ws-1', 'bob', {});
  w.exec('ws-1', 'bob', 'whoami');
  ackAbandon(spawn.spawned[1]);

  assert.deepStrictEqual(spawn.spawned[0].written, [], "alice's shell was untouched");
  assert.deepStrictEqual(spawn.spawned[1].written, [CTRL_C, `whoami${CR}`]);
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
  // `record.command` is what the SHELL reported, carried separately from the
  // command we asked for so the two can be COMPARED — see the mismatch tests
  // below. They agree here, which is the ordinary case.
  assert.strictEqual(w._execState('ws-1', 'alice').pending, null, 'the pending record is cleared');
  // Deliberately inverted: the passive reporter does NOT also see our own
  // command. Both paths append to the same selection queue, so reporting it
  // twice would hand the agent its own command once as a short unasked-for
  // report and once with output. A FOREIGN command still reaches it — the test
  // below pins that half, and the two together are the whole rule.
  assert.strictEqual(passive.length, 0, 'the agent is not told about its own command twice');
});

test('a command the agent did NOT ask for still reaches the passive reporter', () => {
  // The other half of the de-duplication above. Suppressing every command while
  // an exec is pending would lose a real report about the operator's own work.
  const { w, spawn, passive } = mk();
  w.spawn('ws-1', 'alice', {});
  w.exec('ws-1', 'alice', 'npm test');
  spawn.spawned[0].emit(`${C('vim')}x\n${D(0)}`);

  assert.strictEqual(passive.length, 1, 'ENTER: the foreign command was reported');
  assert.strictEqual(passive[0][1].command, 'vim');
});

// ── a foreign D ─────────────────────────────────────────────────────────────

test('a D for a DIFFERENT command is not passed off as our result', () => {
  // The residual PTY-latency window, which no pre-check can close: the operator
  // pressed Enter on `vim` at T and its C mark reaches us at T+ε, so an exec
  // arriving inside that window sees isBusy() false — correctly, nothing has
  // told us yet — and its bytes land in vim's stdin. When vim exits, its D would
  // otherwise be handed to the agent as the answer to `npm test`: plausible,
  // confident, and about a command that never ran.
  const { w, spawn, results } = mk();
  w.spawn('ws-1', 'alice', {});
  assert.strictEqual(w.exec('ws-1', 'alice', 'npm test').ok, true,
    'ENTER: the exec was accepted — the C mark had not arrived yet');
  spawn.spawned[0].emit(`${C('vim')}~\n${D(0)}`);

  assert.strictEqual(results.length, 1, 'it still settles — an unanswered agent is the worse failure');
  const res = results[0][1];
  assert.strictEqual(res.mismatch, true, 'and it is flagged as somebody else’s command');
  assert.notStrictEqual(res.status, undefined);
  assert.strictEqual(res.command, 'npm test', 'the command we asked for');
  assert.strictEqual(res.record.command, 'vim', 'and the one that actually finished');
});

test('a matching D carries no mismatch flag', () => {
  // The control for the test above: `mismatch` must be absent, not merely
  // falsy-by-accident, or every ordinary result would render the warning.
  const { w, spawn, results } = mk();
  w.spawn('ws-1', 'alice', {});
  w.exec('ws-1', 'alice', 'npm test');
  spawn.spawned[0].emit(`${C('npm test')}ok\n${D(0)}`);

  assert.strictEqual(results.length, 1, 'ENTER: it settled');
  assert.ok(!('mismatch' in results[0][1]), 'an ordinary result says nothing about a mismatch');
});

test('a command the shell could not name falls through, it is not called foreign', () => {
  // A C mark carrying no payload leaves record.command empty. That is UNKNOWN,
  // not foreign — engine.js already has an honest answer for it, and flagging a
  // mismatch would tell the agent something false about which command ran.
  const { w, spawn, results } = mk();
  w.spawn('ws-1', 'alice', {});
  w.exec('ws-1', 'alice', 'npm test');
  spawn.spawned[0].emit(`${ESC}]133;C${BEL}out\n${D(0)}`);

  assert.strictEqual(results.length, 1, 'ENTER: it settled');
  assert.strictEqual(results[0][1].record.command, '', 'ENTER: the shell named no command');
  assert.ok(!('mismatch' in results[0][1]), 'unknown is not a mismatch');
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

test('a passive reporter that drops everything is not on the exec answer\'s path', () => {
  // The two callbacks are separate, so a reporter that discards every record
  // cannot reach the answer an agent asked for.
  //
  // RENAMED (t235). This was "an exec answer is delivered even when a reporting
  // pref would drop it", which named a state it could not enter: `mk()` wires a
  // `shimEnv` that always returns a shim, so pref-off was unreachable from here
  // and the test proved nothing about the pref. Worse, the claim was FALSE —
  // engine's pref-off shimEnv returns null, `rec.shimmed` is false, and
  // `exec()` refuses with `no-marks` before any of this runs. The real
  // pref-off behaviour is the test below; this one keeps the callback-
  // separation claim it actually did pin, under a name that says so.
  const { w, spawn, results } = mk({ onCommand: () => {} });
  w.spawn('ws-1', 'alice', {});
  w.exec('ws-1', 'alice', 'ls');
  spawn.spawned[0].emit(`${C('ls')}x\n${D(0)}`);
  assert.strictEqual(results.length, 1);
});

test('no shim (the `off` state) refuses the exec instead of running it blind', () => {
  // What engine's `off` gate actually produces: `shimEnv` returns null, so the
  // shell is born unshimmed and there is no D mark to settle on. Refusing is
  // the only honest answer — the command would still RUN, and the agent would
  // wait forever for an ending nothing can send.
  const { w, spawn, results, passive } = mk({ shimEnv: () => null });
  w.spawn('ws-1', 'alice', {});

  const r = w.exec('ws-1', 'alice', 'ls');
  assert.deepStrictEqual(r, { ok: false, code: 'no-marks' });
  // Nothing was typed: a refusal that still wrote the line would run the
  // command unobserved, which is the outcome the refusal exists to prevent.
  assert.deepStrictEqual(spawn.spawned[0].written, [],
    'ENTER: the shell really was spawned, and nothing was written to it');
  assert.strictEqual(results.length, 0, 'a refusal is the answer; no settle follows');
  assert.deepStrictEqual(passive, [], 'and an unshimmed shell reports nothing passively');
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
  spawn.spawned[0].emit(`${C('their own thing')}x\n`);
  // The assertion below is an ABSENCE, which is also true of a feed that never
  // parsed at all. This proves the parser reached the state the test is about.
  assert.strictEqual(w._execState('ws-1', 'alice').busy, true,
    'ENTER: a command really was open when the abandon arrived');
  spawn.spawned[0].emit(A);
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

test('a timed-out command whose ending never came does not wedge the seat', () => {
  // Nothing but D/abandon/exit clears `pending`, so a command whose bytes were
  // swallowed by something that emits no marks would leave it set for the life
  // of the shell — and every later exec would answer `pending` forever. Once the
  // deadline has passed AND the terminal is idle, the old command is written off
  // so the seat can use its terminal again.
  const { w, spawn, results, timers } = mk({ execTimeoutMs: 30000 });
  w.spawn('ws-1', 'alice', {});
  w.exec('ws-1', 'alice', 'swallowed');
  execTimers(timers)[0].fn();
  assert.strictEqual(results.length, 1, 'ENTER: the deadline notice went out');
  assert.strictEqual(w._execState('ws-1', 'alice').timedOut, true, 'ENTER: and the record survived it');

  assert.deepStrictEqual(w.exec('ws-1', 'alice', 'next'), { ok: true, command: 'next' });
  assert.strictEqual(results.length, 2, 'the abandoned record was written off, not silently dropped');
  assert.deepStrictEqual(results[1], ['alice', {
    status: 'lost', command: 'swallowed', late: true,
  }]);
  assert.strictEqual(w._execState('ws-1', 'alice').pending, 'next');
});

test('a timed-out command that is still RUNNING is not written off', () => {
  // The control for the test above. `lost` is reachable only when the terminal
  // is idle; a command that really is still going must keep refusing, or we
  // would type a second command into the first one's stdin.
  const { w, spawn, results, timers } = mk({ execTimeoutMs: 30000 });
  w.spawn('ws-1', 'alice', {});
  w.exec('ws-1', 'alice', 'sleep 900');
  spawn.spawned[0].emit(C('sleep 900'));
  timers.filter((t) => t.ms === MAX_MS)[0].fn();
  execTimers(timers)[0].fn();
  assert.strictEqual(w._execState('ws-1', 'alice').busy, true, 'ENTER: the terminal is genuinely held');

  assert.deepStrictEqual(w.exec('ws-1', 'alice', 'next'),
    { ok: false, code: 'pending', running: 'sleep 900' });
  assert.strictEqual(results.length, 1, 'nothing was written off');
  // Two entries, not one: the abandon and the command are separate writes. This
  // shell reports no interrupt — the C mark is the operator's own command
  // starting — so the cap is what types, which is the no-marks path above.
  assert.deepStrictEqual(spawn.spawned[0].written, [CTRL_C, `sleep 900${CR}`],
    'and nothing was typed into the running command');
});

test('_execState answers null for a shell that does not exist', () => {
  const { w } = mk();
  assert.strictEqual(w._execState('ws-1', 'nobody'), null);
});
