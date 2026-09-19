'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');

const { createDrawerPtys } = require('../drawer-pty');
const { createMarkParser } = require('../term-marks');
const { vetTermCommand } = require('../drawer-avail');
const { shellHostOf } = require('../term-host');
const { REMOTE_INSTALL_LINE } = require('../term-shim');
const { withUtf8Charset } = require('../env-scopes');

const CTRL_C = String.fromCharCode(0x03);
const CR = String.fromCharCode(0x0d);
const LF = String.fromCharCode(0x0a);
const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);

const constFromSource = (name) => {
  const src = fs.readFileSync(require.resolve('../drawer-pty.js'), 'utf8');
  const m = src.match(new RegExp(`const ${name} = (\\d+);`));
  assert.ok(m, `ENTER: ${name} was found in drawer-pty.js`);
  return Number(m[1]);
};
const ACK_MS = constFromSource('ABANDON_ACK_MS');
const MAX_MS = constFromSource('ABANDON_MAX_MS');
const INSTALL_MS = constFromSource('INSTALL_TIMEOUT_MS');
const QUIET_MS = ACK_MS;

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const A = `${ESC}]133;A${BEL}`;
const C = (cmd) => `${ESC}]133;C;${b64(cmd)}${BEL}`;
const D = (code) => `${ESC}]133;D;${code}${BEL}`;
const TA = `${ESC}]133;A;nest=1${BEL}`;
const TC = (cmd) => `${ESC}]133;C;${b64(cmd)};nest=1${BEL}`;
const TD = (code) => `${ESC}]133;D;${code};nest=1${BEL}`;

const INSTALL_WRITE = ` ${REMOTE_INSTALL_LINE}${CR}`;

function fakePty() {
  const spawned = [];
  const spawn = () => {
    const proc = {
      pid: 3000 + spawned.length,
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

function mk(over = {}) {
  const spawn = fakePty();
  const results = [];
  const passive = [];
  const timers = [];
  const deps = {
    spawn,
    send: () => {},
    shell: '/bin/testsh',
    cwdFor: () => '/tmp/ws',
    scrollbackMax: 64 * 1024,
    env: { PATH: '/usr/bin' },
    log: { info() {}, warn() {}, error() {} },
    setTimeout: (fn, ms) => {
      const t = { fn, ms, fired: false, unrefd: false, unref() { t.unrefd = true; return t; } };
      timers.push(t);
      return t;
    },
    killPid: () => {},
    shimEnv: () => ({ env: { ZDOTDIR: '/run/shim' }, args: ['-l'] }),
    onCommand: (seat, rec) => passive.push([seat, rec]),
    makeMarkParser: createMarkParser,
    onExecResult: (seat, res) => results.push([seat, res]),
    vetCommand: vetTermCommand,
    execTimeoutMs: over.execTimeoutMs || 120000,
    onOutput: () => {},
    onShellEnd: () => {},
    withUtf8Charset,
    remoteAllowed: over.remoteAllowed || (() => true),
    shellHost: over.shellHost || shellHostOf,
    remoteInstallLine: 'remoteInstallLine' in over ? over.remoteInstallLine : REMOTE_INSTALL_LINE,
  };
  const w = createDrawerPtys(deps);
  const fire = (ms, nth = 0) => {
    const due = timers.filter((t) => t.ms === ms && !t.fired);
    assert.ok(due[nth], `ENTER: a timer at ${ms}ms (#${nth}) was armed`);
    due[nth].fired = true;
    due[nth].fn();
  };
  const fireAll = (ms) => {
    for (const t of timers.filter((x) => x.ms === ms && !x.fired)) { t.fired = true; t.fn(); }
  };
  return { w, spawn, results, passive, timers, fire, fireAll };
}

function openSsh(over = {}) {
  const h = mk(over);
  h.w.spawn('ws-1', 'alice', {});
  h.proc = h.spawn.spawned[0];
  h.proc.emit(C('ssh host'));
  assert.strictEqual(h.w._execState('ws-1', 'alice').busy, true,
    'ENTER: the parser sees the outer ssh session holding the tab');
  return h;
}

function installed(over = {}) {
  const h = openSsh(over);
  const r = h.w.exec('ws-1', 'alice', 'ls');
  assert.strictEqual(r.ok, true, 'ENTER: the remote exec was accepted');
  h.proc.emit(`${CR}${LF}`);
  h.fire(QUIET_MS);
  assert.strictEqual(h.proc.written[1], INSTALL_WRITE, 'ENTER: the install line went out');
  h.proc.emit(`${TC('clodex marks')}${TD(0)}`);
  assert.strictEqual(h.proc.written[2], CTRL_C, 'ENTER: the install was acked and step 6 abandoned the far line');
  return h;
}

test('a recognised ssh session takes the remote path — only the abandon is written', () => {
  const h = openSsh();
  const r = h.w.exec('ws-1', 'alice', 'ls');

  assert.deepStrictEqual(r, { ok: true, command: 'ls', inside: 'ssh host' },
    'the caller is told which session its command is going into, captured at exec time');
  assert.deepStrictEqual(h.proc.written, [CTRL_C],
    'the install line waits for the quiet clock — nothing else has been typed yet');
  assert.strictEqual(h.w._execState('ws-1', 'alice').depth, 1);
  assert.strictEqual(h.w._execState('ws-1', 'alice').inside, 'ssh host');
  assert.strictEqual(h.w._execState('ws-1', 'alice').remoteInstalled, false);
});

test('the install line goes out once the far side has spoken and then gone quiet', () => {
  const h = openSsh();
  h.w.exec('ws-1', 'alice', 'ls');
  h.proc.emit(`${CR}${LF}$ `);

  assert.deepStrictEqual(h.proc.written, [CTRL_C], 'bytes alone do not release it — the quiet window has not elapsed');
  h.fire(QUIET_MS);
  assert.deepStrictEqual(h.proc.written, [CTRL_C, INSTALL_WRITE]);
  assert.ok(h.proc.written[1].startsWith(' '),
    'the leading space is sacrificial: the measured loss is the LEADING byte, so a lost space leaves the line whole');
});

test('more far output restarts the quiet clock rather than typing into a talking shell', () => {
  const h = openSsh();
  h.w.exec('ws-1', 'alice', 'ls');
  h.proc.emit('first');
  h.proc.emit('second');
  h.fire(QUIET_MS);

  assert.deepStrictEqual(h.proc.written, [CTRL_C], 'the first burst’s clock was superseded by the second');
  h.fire(QUIET_MS);
  assert.deepStrictEqual(h.proc.written, [CTRL_C, INSTALL_WRITE]);
});

test('a far side that says NOTHING still gets the install line, on the cap', () => {
  const h = openSsh();
  h.w.exec('ws-1', 'alice', 'ls');

  assert.deepStrictEqual(h.proc.written, [CTRL_C], 'ENTER: nothing arrived to start the quiet clock');
  h.fire(MAX_MS);
  assert.deepStrictEqual(h.proc.written, [CTRL_C, INSTALL_WRITE],
    'ABANDON_MAX_MS is the same cap the local path already accepts as its fallback');
});

test('the install line is written exactly once even if both clocks fire', () => {
  const h = openSsh();
  h.w.exec('ws-1', 'alice', 'ls');
  h.proc.emit('x');
  h.fire(QUIET_MS);
  h.fire(MAX_MS);

  assert.deepStrictEqual(h.proc.written, [CTRL_C, INSTALL_WRITE]);
});

test('a tagged D;0 installs, and the nested exec then runs the local algorithm one hop down', () => {
  const h = installed();
  assert.strictEqual(h.w._execState('ws-1', 'alice').remoteInstalled, true);

  h.proc.emit(`${TD(0)}${TA}`);
  assert.deepStrictEqual(h.proc.written, [CTRL_C, INSTALL_WRITE, CTRL_C],
    'the far shell’s first uninterrupted prompt is a redraw, not our ack — it must not release the command');

  h.proc.emit(`${TD(130)}${TA}`);
  assert.deepStrictEqual(h.proc.written, [CTRL_C, INSTALL_WRITE, CTRL_C, `ls${CR}`]);

  h.proc.emit(`${TC('ls')}a.txt\n${TD(0)}`);
  assert.deepStrictEqual(h.results, [['alice', {
    status: 'ok',
    record: { command: 'ls', exitCode: 0, output: 'a.txt\n', depth: 1, inside: 'ssh host' },
    command: 'ls',
    late: false,
    inside: 'ssh host',
  }]]);
  assert.deepStrictEqual(h.passive, [], 'a command the agent asked for must not also reach the reporting firehose');
  assert.strictEqual(h.w._execState('ws-1', 'alice').pending, null);
});

test('ORDERING: an UNTAGGED ack is the local shell’s and must not type into a dead session', () => {
  const h = installed();

  h.proc.emit(`${D(130)}${A}`);

  assert.deepStrictEqual(h.proc.written, [CTRL_C, INSTALL_WRITE, CTRL_C],
    'a tag-blind ack would type `ls` into the local shell the untagged D just handed back');
  assert.strictEqual(h.results.length, 1, 'exactly one delivery for the command that never ran');
  assert.deepStrictEqual(h.results[0], ['alice', {
    status: 'shell-gone',
    reason: 'the session ended',
    command: 'ls',
    late: false,
    inside: 'ssh host',
  }]);
  const st = h.w._execState('ws-1', 'alice');
  assert.strictEqual(st.busy, false, 'the untagged D closed the outer capture');
  assert.strictEqual(st.remoteInstalled, false, 'and the install state went with the far shell');
});

test('ORDERING: the install line is written ONCE per outer session, and again for the next one', () => {
  const h = installed();
  h.proc.emit(`${TD(130)}${TA}`);
  h.proc.emit(`${TC('ls')}${TD(0)}`);
  assert.strictEqual(h.results.length, 1, 'ENTER: the first remote command settled');

  assert.strictEqual(h.w.exec('ws-1', 'alice', 'whoami').ok, true);
  h.proc.emit(`${TD(130)}${TA}`);
  assert.strictEqual(
    h.proc.written.filter((x) => x === INSTALL_WRITE).length, 1,
    're-installing per command would retype ~1KB into the operator’s far shell on every exec',
  );
  assert.deepStrictEqual(h.proc.written.slice(-2), [CTRL_C, `whoami${CR}`]);

  h.proc.emit(`${TC('whoami')}root\n${TD(0)}`);
  h.proc.emit(`${D(0)}${A}`);
  h.proc.emit(C('ssh host'));
  assert.strictEqual(h.w.exec('ws-1', 'alice', 'uptime').ok, true);
  h.proc.emit('x');
  h.fireAll(QUIET_MS);
  assert.strictEqual(
    h.proc.written.filter((x) => x === INSTALL_WRITE).length, 2,
    'the install is keyed to outerSeq, never a sticky flag: a second ssh is a different far shell',
  );
});

test('a far shell that answers D;2 is refused by name, with nothing of the agent’s typed', () => {
  const h = openSsh();
  h.w.exec('ws-1', 'alice', 'ls');
  h.fire(MAX_MS);
  h.proc.emit(`${TC('clodex marks')}${TD(2)}`);

  assert.strictEqual(h.results.length, 1);
  const [, res] = h.results[0];
  assert.strictEqual(res.status, 'remote-unsupported');
  assert.strictEqual(res.command, 'ls');
  assert.strictEqual(res.inside, 'ssh host');
  assert.match(res.reason, /neither bash 4\.4\+ nor zsh/);
  assert.deepStrictEqual(h.proc.written, [CTRL_C, INSTALL_WRITE], 'the command was never typed');
  assert.strictEqual(h.w._execState('ws-1', 'alice').pending, null);
  assert.strictEqual(h.w._execState('ws-1', 'alice').remoteInstalled, false);
});

test('a far bash below 4.4 answers D;3 and is named separately', () => {
  const h = openSsh();
  h.w.exec('ws-1', 'alice', 'ls');
  h.fire(MAX_MS);
  h.proc.emit(`${TC('clodex marks')}${TD(3)}`);

  assert.strictEqual(h.results.length, 1);
  assert.match(h.results[0][1].reason, /older than 4\.4/);
  assert.notStrictEqual(h.results[0][1].reason, 'the remote shell is neither bash 4.4+ nor zsh (a POSIX sh, busybox, or ksh), so it cannot report results back. Nothing was run there.');
  assert.deepStrictEqual(h.proc.written, [CTRL_C, INSTALL_WRITE]);
});

test('silence past INSTALL_TIMEOUT_MS is answered once, and a late tagged A resurrects nothing', () => {
  const h = openSsh();
  h.w.exec('ws-1', 'alice', 'ls');
  h.fire(MAX_MS);
  h.fire(INSTALL_MS);

  assert.strictEqual(h.results.length, 1);
  assert.strictEqual(h.results[0][1].status, 'remote-unsupported');
  assert.match(h.results[0][1].reason, /did not answer/);
  assert.strictEqual(h.w._execState('ws-1', 'alice').pending, null);

  h.proc.emit(`${TD(0)}${TA}`);
  assert.strictEqual(h.results.length, 1, 'a settled exec is settled — a late far prompt cannot deliver twice');
  assert.deepStrictEqual(h.proc.written, [CTRL_C, INSTALL_WRITE], 'nor type the command it already refused');
});

test('an install that answered in time is not also timed out', () => {
  const h = installed();
  h.fire(INSTALL_MS);

  assert.deepStrictEqual(h.results, [], 'the install timer found its answer already in');
});

test('remote off: a recognised session gets today’s busy refusal, flagged as offerable', () => {
  const h = openSsh({ remoteAllowed: () => false });

  assert.deepStrictEqual(h.w.exec('ws-1', 'alice', 'ls'),
    { ok: false, code: 'busy', running: 'ssh host', remoteOffer: true });
  assert.deepStrictEqual(h.proc.written, [], 'nothing was typed into a session the operator has not opened up');
});

test('remote off over an UNRECOGNISED program offers nothing — the refusal is today’s, verbatim', () => {
  const h = mk({ remoteAllowed: () => false });
  h.w.spawn('ws-1', 'alice', {});
  h.spawn.spawned[0].emit(C('vim notes.txt'));

  assert.deepStrictEqual(h.w.exec('ws-1', 'alice', 'ls'),
    { ok: false, code: 'busy', running: 'vim notes.txt' });
});

test('remote on, but the program is not a shell host: today’s refusal, verbatim', () => {
  const h = mk();
  h.w.spawn('ws-1', 'alice', {});
  h.spawn.spawned[0].emit(C('vim notes.txt'));

  assert.deepStrictEqual(h.w.exec('ws-1', 'alice', 'ls'),
    { ok: false, code: 'busy', running: 'vim notes.txt' });
  assert.deepStrictEqual(h.spawn.spawned[0].written, [], 'nothing was typed into vim');
});

test('a full-screen program has the remote session — refused before the install is typed', () => {
  const h = openSsh();
  h.proc.emit(`${ESC}[?1049h`);
  assert.strictEqual(h.w._execState('ws-1', 'alice').busy, true, 'ENTER: the ssh session is still the outer command');

  assert.deepStrictEqual(h.w.exec('ws-1', 'alice', 'ls'),
    { ok: false, code: 'full-screen', running: 'ssh host' });
  assert.deepStrictEqual(h.proc.written, [], 'the install line is keystrokes, and vim would eat them');
});

test('the alt-screen gate reopens when the far program leaves the screen', () => {
  const h = openSsh();
  h.proc.emit(`${ESC}[?1049h`);
  assert.strictEqual(h.w.exec('ws-1', 'alice', 'ls').code, 'full-screen', 'ENTER: it was refused while up');

  h.proc.emit(`${ESC}[?1049l`);
  assert.strictEqual(h.w.exec('ws-1', 'alice', 'ls').ok, true);
});

test('a far command already running is refused by name, naming the session too', () => {
  const h = installed();
  h.proc.emit(`${TD(130)}${TA}`);
  h.proc.emit(TC('vim notes.txt'));
  h.proc.emit(`${TD(0)}`);
  assert.strictEqual(h.results.length, 1, 'ENTER: the first exec settled on its own D');
  h.proc.emit(TC('vim notes.txt'));

  assert.deepStrictEqual(h.w.exec('ws-1', 'alice', 'ls'),
    { ok: false, code: 'busy', running: 'vim notes.txt', inside: 'ssh host' });
});

test('exit mid-command: one session-ended delivery, and the install state goes with it', () => {
  const h = installed();
  h.proc.emit(`${TD(130)}${TA}`);
  h.proc.emit(`${TC('ls')}${TD(0)}`);
  assert.strictEqual(h.results.length, 1, 'ENTER: the first far command settled normally');
  assert.strictEqual(h.w.exec('ws-1', 'alice', 'exit').ok, true);
  h.proc.emit(`${TD(130)}${TA}`);
  assert.deepStrictEqual(h.proc.written.slice(-1), [`exit${CR}`], 'ENTER: the command was typed into the far shell');
  h.proc.emit(TC('exit'));

  h.proc.emit(`${D(0)}${A}`);

  assert.strictEqual(h.results.length, 2, 'exactly one delivery for the second command — no wedge, no double');
  assert.deepStrictEqual(h.results[1], ['alice', {
    status: 'session-ended',
    outerExit: 0,
    command: 'exit',
    late: false,
    inside: 'ssh host',
  }], 'the outer exit code is in the message because it is the only status there is');
  const st = h.w._execState('ws-1', 'alice');
  assert.strictEqual(st.busy, false);
  assert.strictEqual(st.remoteInstalled, false);
  assert.strictEqual(st.pending, null);
});

test('an exec that typed but whose far C never arrived is told the session ended', () => {
  const h = installed();
  h.proc.emit(`${TD(130)}${TA}`);
  assert.deepStrictEqual(h.proc.written.slice(-1), [`ls${CR}`], 'ENTER: the command went out with no far C yet');

  h.proc.emit(`${D(0)}${A}`);

  assert.strictEqual(h.results.length, 1, 'the pending would otherwise sit until its 120s deadline');
  assert.deepStrictEqual(h.results[0], ['alice', {
    status: 'shell-gone',
    reason: 'the session ended',
    command: 'ls',
    late: false,
    inside: 'ssh host',
  }]);
});

test('the far session ending under an OPERATOR’s command still reports it passively', () => {
  const h = installed();
  h.proc.emit(`${TD(130)}${TA}`);
  h.proc.emit(`${TC('ls')}${TD(0)}`);
  assert.strictEqual(h.results.length, 1, 'ENTER: the agent’s exec is settled and gone');

  h.proc.emit(TC('exit'));
  h.proc.emit(`${D(0)}${A}`);

  assert.deepStrictEqual(h.passive.map(([, r]) => [r.command, r.depth, !!r.sessionEnded]),
    [['exit', 1, true], ['ssh host', 0, false]],
    'the inner is announced before the tab is announced free');
});

test('a deadline at depth 1 names the session and does not cancel the far command', () => {
  const h = installed({ execTimeoutMs: 30000 });
  h.proc.emit(`${TD(130)}${TA}`);
  h.proc.emit(TC('ls'));
  h.fire(30000);

  assert.deepStrictEqual(h.results, [['alice', {
    status: 'timeout', command: 'ls', afterMs: 30000, inside: 'ssh host',
  }]]);
  assert.strictEqual(h.proc.killed, false, 'the operator’s far command was not killed to meet our deadline');

  h.proc.emit(`${TD(0)}`);
  assert.strictEqual(h.results.length, 2);
  assert.strictEqual(h.results[1][1].late, true, 'the late result supersedes the deadline notice');
  assert.strictEqual(h.results[1][1].inside, 'ssh host');
});

test('a timed-out far command that is STILL open keeps refusing by name, not swept as lost', () => {
  const h = installed({ execTimeoutMs: 30000 });
  h.proc.emit(`${TD(130)}${TA}`);
  h.proc.emit(TC('vim notes.txt'));
  h.fire(30000);
  assert.strictEqual(h.w._execState('ws-1', 'alice').timedOut, true, 'ENTER: the deadline passed');

  assert.deepStrictEqual(h.w.exec('ws-1', 'alice', 'next'),
    { ok: false, code: 'pending', running: 'ls' });
  assert.strictEqual(h.results.length, 1, 'nothing was written off while its layer is genuinely busy');
});

test('a timed-out far command whose layer went idle IS swept, so the seat is not wedged', () => {
  const h = installed({ execTimeoutMs: 30000 });
  h.proc.emit(`${TD(130)}${TA}`);
  h.fire(30000);
  assert.strictEqual(h.w._execState('ws-1', 'alice').timedOut, true, 'ENTER: the deadline passed');
  assert.strictEqual(h.w._execState('ws-1', 'alice').busy, true,
    'ENTER: the OUTER is still held, so a depth-0 reading of busy would refuse forever');

  assert.strictEqual(h.w.exec('ws-1', 'alice', 'next').ok, true);
  assert.deepStrictEqual(h.results[1], ['alice', {
    status: 'lost', command: 'ls', late: true, inside: 'ssh host',
  }]);
});

test('every other ending delivers exactly once at depth 1 — shell exit, window close, tab close', () => {
  for (const [name, end] of [
    ['shell exit', (h) => h.proc.exit(7)],
    ['window close', (h) => h.w.kill('ws-1')],
    ['tab close', (h) => h.w.killSeat('ws-1', 'alice')],
  ]) {
    const h = installed();
    h.proc.emit(`${TD(130)}${TA}`);
    h.proc.emit(TC('ls'));
    end(h);

    assert.strictEqual(h.results.length, 1, `${name}: exactly one delivery`);
    assert.strictEqual(h.results[0][1].command, 'ls', `${name}: for the command that was running`);
    assert.strictEqual(h.results[0][1].inside, 'ssh host', `${name}: naming the session it ran in`);
  }
});

test('an abandoned far command is reported abandoned and carries its session', () => {
  const h = installed();
  h.proc.emit(`${TD(130)}${TA}`);
  h.proc.emit(`${TC('ls')}half`);
  h.proc.emit(TA);

  assert.strictEqual(h.results.length, 1);
  assert.deepStrictEqual(h.results[0], ['alice', {
    status: 'abandoned',
    record: { command: 'ls', output: 'half', depth: 1, inside: 'ssh host' },
    command: 'ls',
    late: false,
    inside: 'ssh host',
  }]);
});

test('a local exec after the session ends is ordinary again — no inside, no install', () => {
  const h = installed();
  h.proc.emit(`${TD(130)}${TA}`);
  h.proc.emit(TC('exit'));
  h.proc.emit(`${D(0)}${A}`);
  assert.strictEqual(h.w._execState('ws-1', 'alice').busy, false, 'ENTER: the tab is back at the local shell');

  const before = h.proc.written.length;
  assert.deepStrictEqual(h.w.exec('ws-1', 'alice', 'ls'), { ok: true, command: 'ls' });
  h.proc.emit(`${D(130)}${A}`);
  assert.deepStrictEqual(h.proc.written.slice(before), [CTRL_C, `ls${CR}`],
    'the local path types on the LOCAL ack and installs nothing');
});

test('a far record the agent did not ask for reaches the reporting firehose', () => {
  const h = openSsh();
  h.proc.emit(`${TC('uname -a')}Linux\n${TD(0)}`);

  assert.deepStrictEqual(h.passive, [['alice', {
    command: 'uname -a', exitCode: 0, output: 'Linux\n', depth: 1, inside: 'ssh host',
  }]]);
  assert.deepStrictEqual(h.results, [], 'nobody asked for it, so nobody is waiting on it');
});

test('the install line is the exported constant, typed with one leading space and one CR', () => {
  const h = openSsh();
  h.w.exec('ws-1', 'alice', 'ls');
  h.fire(MAX_MS);

  assert.strictEqual(h.proc.written[1], ` ${REMOTE_INSTALL_LINE}${CR}`);
  assert.strictEqual(h.proc.written[1].split(CR).length, 2, 'one line, one Enter');
  assert.ok(!/[\x00-\x09\x0b-\x1f]/.test(REMOTE_INSTALL_LINE),
    'ENTER: the exported line carries no raw control byte a line editor would act on');
});
