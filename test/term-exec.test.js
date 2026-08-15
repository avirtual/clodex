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

// A real shell answers the abandon signal — a prompt redraw, at minimum — and
// drawer-pty types the command only once it has, because SIGINT discards input
// that shares its write. The fake emits nothing on its own, so tests drive that
// acknowledgement here. Deliberately NOT automatic inside `write()`: a fixture
// that acked itself would make the two-write split untestable, and the split is
// the whole fix.
// Answering is not enough on its own: drawer-pty types once the answer has gone
// QUIET, because the SIGINT input flush outlasts the first byte of the reply.
// So the acknowledgement is the bytes AND the quiet window elapsing, and this
// helper models both — a fixture that emitted without letting the window expire
// would report the command as never typed and pin a contract the product does
// not have.
// Read from the source, not hand-copied. A duplicated literal that drifts from
// the product's makes `quietElapse` match nothing and become a silent no-op —
// every test here would then pass against a product that never waits at all —
// and it would leak the stale value into `execTimers`, surfacing as an
// unrelated wrong-timer failure somewhere downstream.
const constFromSource = (name) => {
  const src = fs.readFileSync(require.resolve('../drawer-pty.js'), 'utf8');
  const m = src.match(new RegExp(`const ${name} = (\\d+);`));
  assert.ok(m, `ENTER: ${name} was found in drawer-pty.js`);
  return Number(m[1]);
};
const QUIET_MS = constFromSource('ABANDON_QUIET_MS');
const MAX_MS = constFromSource('ABANDON_MAX_MS');
// The LAST quiet timer, not the first: every byte re-arms the window, and only
// the newest one still types.
const quietElapse = (timers) => {
  const quiet = (timers || []).filter((t) => t.ms === QUIET_MS);
  assert.ok(quiet.length, 'ENTER: a quiet window was armed — without one this helper is a no-op');
  quiet[quiet.length - 1].fn();
};
const ackAbandon = (proc) => {
  proc.emit(`${CR}${LF}$ `);
  quietElapse(proc.timers);
};

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
      // Also hung off the pty so `ackAbandon` can reach the quiet window from a
      // proc alone, without every call site having to destructure `timers`.
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
// The deadline timers, by EXCLUDING the two known others (the 5s kill
// escalation and the 250ms abandon-ack fallback) rather than by taking [0].
// Positional indexing broke silently when the ack timer was added — it is armed
// first, so `[0]` became the wrong timer and tests asserting a timeout were
// firing an arm instead. Every caller below indexes into this, so a pattern that
// admits an extra row does not fail here; it fails somewhere downstream that
// looks unrelated.
const execTimers = (timers) => timers.filter((t) => t.ms !== 5000 && t.ms !== 250 && t.ms !== QUIET_MS && t.ms !== MAX_MS);

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
    'the shell spoke, so the command follows as its own write');
  assert.deepStrictEqual(results, [], 'and typing it settles nothing on its own');
});

// The three tests below pin the QUIET WINDOW specifically. The tests around
// them pass against an arm that types on the first byte, so without these a
// revert to that would be caught by nothing but a ~1-in-280 real-shell flake.

test('a first byte is not the end of the flush — the command waits for quiet', () => {
  // The bytes that arrive first are the ones ALREADY IN FLIGHT when the ^C
  // landed: a prior command's echo, an OSC 7 cwd report. They are not an answer
  // to the signal, and typing on them puts the command inside the input discard,
  // which drops characters out of its MIDDLE and still runs the remainder.
  const { w, spawn } = mk();
  w.spawn('ws-1', 'alice', {});
  w.exec('ws-1', 'alice', 'ls');

  spawn.spawned[0].emit(`${CR}${LF}$ `);
  assert.deepStrictEqual(spawn.spawned[0].written, [CTRL_C],
    'the shell has spoken but has not gone quiet — nothing typed yet');
});

test('a byte arriving inside the quiet window restarts it', () => {
  // Otherwise the first byte's timer types 60ms in, while the answer is still
  // arriving — the same defect as typing on the first byte, one window later.
  const { w, spawn, timers } = mk();
  w.spawn('ws-1', 'alice', {});
  w.exec('ws-1', 'alice', 'ls');

  spawn.spawned[0].emit(`${CR}${LF}`);
  const stale = timers.filter((t) => t.ms === QUIET_MS);
  assert.strictEqual(stale.length, 1, 'ENTER: the first byte armed a window');
  spawn.spawned[0].emit('$ ');
  stale[0].fn();
  assert.deepStrictEqual(spawn.spawned[0].written, [CTRL_C],
    'the superseded window does not type — a later byte outranks it');

  quietElapse(timers);
  assert.deepStrictEqual(spawn.spawned[0].written, [CTRL_C, `ls${CR}`],
    'and the newest window, once it elapses, is the one that types');
});

// The SWALLOWED FIRST BYTE, driven deterministically. This reproduced only
// under machine contention before — 8+ occurrences over four days across two
// shells, two keymaps and four agents, always one red row in an otherwise green
// suite, and it cost at least one false review rejection. Nothing here depends
// on load or timing: the interleaving is driven through the injected timer seam,
// so it either holds on every run or fails on every run.
//
// The defect: `execArm` is fed by RAW BYTES, which cannot distinguish output
// caused by our ^C from output already in flight when we wrote it. Under load
// the quiet window elapses over pre-^C bytes while the signal is still queued,
// the command is typed, and THEN SIGINT lands and discards it — taking the head
// of the command with it. `cho a; echo b` from `echo a; echo b`.
test('a prompt mark types the command — the byte window alone cannot tell the flush started', () => {
  const { w, spawn } = mk();
  w.spawn('ws-1', 'alice', {});
  w.exec('ws-1', 'alice', 'ls');
  const proc = spawn.spawned[0];

  // Pre-^C output: a prior command's tail, still in flight when the signal was
  // written. Under the byte-only handshake this armed the window and, 60ms
  // later, typed into a shell that had not yet processed the interrupt.
  proc.emit(`${CR}${LF}`);
  assert.deepStrictEqual(proc.written, [CTRL_C],
    'ENTER: still held back on raw bytes alone — the window has not elapsed');

  // The prompt mark is the shell's own precmd speaking: the interrupt has been
  // processed and the line editor is ready. It types WITHOUT waiting out the
  // window, which is the point — the window was only ever estimating this.
  proc.emit(A);
  assert.deepStrictEqual(proc.written, [CTRL_C, `ls${CR}`],
    'the mark is a positive acknowledgement and types immediately');
});

test('the command is typed exactly once when the mark AND the clocks both fire', () => {
  // The clocks are retained as the backstop, so both paths stay live on a
  // shell that emits marks. A second copy would run the command twice — and a
  // duplicated `rm -rf` is not a cosmetic defect.
  const { w, spawn, timers } = mk();
  w.spawn('ws-1', 'alice', {});
  w.exec('ws-1', 'alice', 'ls');
  const proc = spawn.spawned[0];

  proc.emit(A);
  assert.deepStrictEqual(proc.written, [CTRL_C, `ls${CR}`], 'ENTER: the mark typed it');

  quietElapse(timers);
  timers.filter((t) => t.ms === 250)[0].fn();
  timers.filter((t) => t.ms === MAX_MS)[0].fn();
  assert.deepStrictEqual(proc.written, [CTRL_C, `ls${CR}`],
    'every later clock is a no-op — the command went out once');
});

test('a shell that sends no marks still gets its command, on the clocks', () => {
  // Not hypothetical: term-exec-keymap.test.js drives real shells with the
  // parser stubbed to `feed(){}`, because its question is about which BYTES
  // reach the line editor. A mark-only wait would hang every one of those rows
  // forever, which is why the clocks are kept rather than replaced.
  const { w, spawn, timers } = mk();
  w.spawn('ws-1', 'alice', {});
  w.exec('ws-1', 'alice', 'ls');
  const proc = spawn.spawned[0];

  proc.emit(`${CR}${LF}$ `);
  assert.deepStrictEqual(proc.written, [CTRL_C], 'ENTER: no mark, so nothing typed yet');
  quietElapse(timers);
  assert.deepStrictEqual(proc.written, [CTRL_C, `ls${CR}`],
    'the quiet window still delivers for a shell that never marks its prompt');
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

  proc.emit(A);
  assert.deepStrictEqual(proc.written, [CTRL_C, `first${CR}`], 'ENTER: the first command went out');
  // Settle it so the seat is free, then start a second command.
  proc.emit(C('first'));
  proc.emit(D(0));
  proc.written.length = 0;
  assert.strictEqual(w.exec('ws-1', 'alice', 'second').ok, true, 'ENTER: a second exec was accepted');

  // A prompt mark now belongs to the SECOND command's handshake only. If the
  // first exec's ack were still wired, this would type `second` twice.
  proc.emit(A);
  assert.deepStrictEqual(proc.written, [CTRL_C, `second${CR}`],
    'exactly one copy — the first exec released its ack when it typed');
});

test('a shell that never goes quiet still gets its command, on the cap', () => {
  // Reachable without any misbehaviour: isBusy() is false while a BACKGROUND
  // job writes to the tty, so exec() is accepted and the ^C is delivered. With
  // only a restarting window the command would never be typed at all and the
  // waiter would hang to EXEC_TIMEOUT, reporting a timeout for a command that
  // never ran.
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

  // A chatty shell must not schedule a window per data chunk for the rest of
  // its life once the command is already out.
  const before = timers.length;
  spawn.spawned[0].emit('more chatter');
  assert.strictEqual(timers.length, before, 'no further timers are armed after the command is typed');
});

test('the silence deadline is inert once the shell has spoken', () => {
  // Both clocks are armed up front, so the 250ms deadline is still in the list
  // after an answer arrives. Firing mid-answer would type into the flush — the
  // exact race the quiet window exists to close.
  const { w, spawn, timers } = mk();
  w.spawn('ws-1', 'alice', {});
  w.exec('ws-1', 'alice', 'ls');

  spawn.spawned[0].emit(`${CR}${LF}$ `);
  const silence = timers.filter((t) => t.ms === 250);
  assert.strictEqual(silence.length, 1, 'ENTER: the silence deadline was armed');
  silence[0].fn();
  assert.deepStrictEqual(spawn.spawned[0].written, [CTRL_C],
    'the deadline handed ownership to the quiet window and types nothing itself');
});

test('a shell that answers nothing still gets its command, on the fallback', () => {
  // ^C on an already-empty line under a prompt that does not redraw. Waiting
  // forever would be a command that never runs and an agent that never hears
  // back — the one outcome this module exists to prevent.
  const { w, spawn, timers } = mk();
  w.spawn('ws-1', 'alice', {});
  w.exec('ws-1', 'alice', 'ls');
  assert.deepStrictEqual(spawn.spawned[0].written, [CTRL_C], 'ENTER: still held back');

  const arm = timers.filter((t) => t.ms === 250);
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

  timers.filter((t) => t.ms === 250)[0].fn();
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
  const staleArm = timers.filter((t) => t.ms === 250)[0];
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
  quietElapse(timers);
  execTimers(timers)[0].fn();
  assert.strictEqual(w._execState('ws-1', 'alice').busy, true, 'ENTER: the terminal is genuinely held');

  assert.deepStrictEqual(w.exec('ws-1', 'alice', 'next'),
    { ok: false, code: 'pending', running: 'sleep 900' });
  assert.strictEqual(results.length, 1, 'nothing was written off');
  // Two entries, not one: the abandon and the command are separate writes. The
  // C mark at the top of this test doubles as the shell's acknowledgement, so
  // only its quiet window has to elapse — no explicit ackAbandon is needed.
  assert.deepStrictEqual(spawn.spawned[0].written, [CTRL_C, `sleep 900${CR}`],
    'and nothing was typed into the running command');
});

test('_execState answers null for a shell that does not exist', () => {
  const { w } = mk();
  assert.strictEqual(w._execState('ws-1', 'nobody'), null);
});
