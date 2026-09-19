'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

const { createDrawerPtys } = require('../drawer-pty');
const { buildTermShim, REMOTE_INSTALL_LINE, REMOTE_HELLO_B64, remoteUnsupportedReason } = require('../term-shim');
const { createMarkParser } = require('../term-marks');
const { shellHostOf } = require('../term-host');
const { vetTermCommand } = require('../drawer-avail');
const { withUtf8Charset } = require('../env-scopes');
const { stripAnsi } = require('../cli/src/output');
const { reapPty } = require('./lib/pty-reap');
const { mkTmpRoot } = require('./lib/tmp-roots');

const CR = String.fromCharCode(0x0d);

let pty = null;
try { pty = require('node-pty'); } catch {}

function shimmable(p) {
  try {
    if (!fs.statSync(p).isFile()) return false;
  } catch { return false; }
  const probe = mkTmpRoot('clodex-remote-probe-');
  try {
    return !!buildTermShim({ dir: probe, shell: p });
  } catch { return false; } finally {
    try { fs.rmSync(probe, { recursive: true, force: true }); } catch {}
  }
}

const LOCAL_SHELLS = [
  ['zsh', '/bin/zsh'],
  ['bash', '/opt/homebrew/bin/bash'],
].filter(([, p]) => shimmable(p));

const present = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };

const FAR_SHELLS = [
  ['bash 5', '/opt/homebrew/bin/bash --norc --noprofile'],
  ['zsh', '/bin/zsh -f'],
].filter(([, line]) => present(line.split(' ')[0]));

const SETTLE_MS = 20000;

function waitFor(pred, ms = SETTLE_MS) {
  return new Promise((resolve) => {
    const end = Date.now() + ms;
    const tick = () => {
      if (pred()) return resolve(true);
      if (Date.now() > end) return resolve(false);
      setTimeout(tick, 20);
    };
    tick();
  });
}

const FAR_UP = ['FAR', 'IS', 'UP'].join('_');
const SEAT_READY = ['SEAT', 'READY'].join('_');

const printed = (output, word) => stripAnsi(String(output))
  .split(/\r?\n/).map((l) => l.trim()).includes(word);

function harness(shellPath) {
  const results = [];
  const procs = [];
  const dir = mkTmpRoot('clodex-remote-shell-');
  const ptys = createDrawerPtys({
    spawn: (file, args, opts) => {
      const p = pty.spawn(file, args, opts);
      p.out = '';
      p.onData((d) => { p.out += d; });
      procs.push(p);
      return p;
    },
    send: () => {},
    shell: shellPath,
    cwdFor: () => process.env.HOME || '/',
    shimEnv: () => buildTermShim({ dir, shell: shellPath }),
    withUtf8Charset,
    makeMarkParser: createMarkParser,
    onCommand: () => {},
    onExecResult: (seat, res) => results.push(res),
    vetCommand: vetTermCommand,
    remoteAllowed: () => true,
    shellHost: shellHostOf,
    remoteInstallLine: REMOTE_INSTALL_LINE,
    remoteUnsupportedReason,
    log: { info() {}, warn() {}, error() {} },
  });
  const out = () => procs.map((p) => p.out).join('');
  const dispose = async () => {
    try { ptys.dispose(); } catch {}
    for (const p of procs) {
      try { if (!(await reapPty(p, { graceMs: 150 }))) console.error(`reapPty: pid ${p.pid} survived SIGKILL`); } catch {}
    }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  };
  return { ptys, out, results, procs, dispose };
}

async function openSeat(h, seat) {
  const res = h.ptys.spawn('w', seat, { cols: 200, rows: 24 });
  assert.strictEqual(res.ok, true, `ENTER: the local shell spawned (${res.error})`);
  assert.strictEqual(h.ptys._execState('w', seat).shimmed, true,
    'ENTER: the LOCAL shell was born shimmed — an unshimmed one refuses every exec');
  const proc = h.procs[h.procs.length - 1];
  proc.write(`echo SEAT''_READY${CR}`);
  const ready = await waitFor(() => proc.out.includes(SEAT_READY)
    && h.ptys._execState('w', seat).busy === false);
  assert.ok(ready,
    'ENTER: the local shell answered a line and its end mark reached the parser — a far shell started '
    + `before its rc ran is read by nothing\n--- out ---\n${proc.out}`);
  return proc;
}

async function openFar(h, seat, proc, farLine) {
  const before = proc.out.length;
  proc.write(`${farLine}${CR}`);
  const busy = await waitFor(() => {
    const st = h.ptys._execState('w', seat);
    return !!st && st.busy === true;
  });
  assert.ok(busy, `ENTER: the local shell's C mark opened a capture for the far session\n--- out ---\n${proc.out.slice(before)}`);
  proc.write(`echo FAR''_IS''_UP${CR}`);
  const up = await waitFor(() => proc.out.slice(before).includes(FAR_UP));
  assert.ok(up,
    'ENTER: the far shell is reading keystrokes — the marker is echoed BY it, which a blind wait only assumes'
    + `\n--- out ---\n${proc.out.slice(before)}`);
  assert.strictEqual(h.ptys._execState('w', seat).busy, true,
    'ENTER: the outer capture is STILL open — a far shell that inherited our shim would have closed it with untagged marks');
  return before;
}

async function execAndWait(h, seat, command, n) {
  const r = h.ptys.exec('w', seat, command);
  assert.strictEqual(r.ok, true, `exec accepted: ${r.code || ''} ${r.error || ''}`);
  const got = await waitFor(() => h.results.length >= n);
  assert.ok(got, `a result arrived for \`${command}\`\n--- out ---\n${h.out()}`);
  return r;
}

for (const [localName, localPath] of LOCAL_SHELLS) {
  for (const [farName, farLine] of FAR_SHELLS) {
    test(`${localName} → ${farName}: a command runs in the far shell and reports its own exit code`,
      { skip: !pty ? 'node-pty unavailable' : false, timeout: 90000 }, async () => {
        const h = harness(localPath);
        try {
          const proc = await openSeat(h, 'seat');
          const mark = await openFar(h, 'seat', proc, farLine);

          const r = await execAndWait(h, 'seat', 'echo hi', 1);
          assert.strictEqual(r.inside, farLine, 'the caller is told which session its command went into');

          const res = h.results[0];
          assert.strictEqual(res.status, 'ok', `status ok\n--- out ---\n${h.out()}`);
          assert.strictEqual(res.inside, farLine, 'and so is the result');
          assert.strictEqual(res.record.exitCode, 0);
          assert.strictEqual(res.record.command, 'echo hi',
            'the far preexec named what actually ran, so nothing here is assumed');
          assert.ok(printed(res.record.output, 'hi'),
            `the far command's OUTPUT came back, framed by the far marks alone\n--- captured ---\n${res.record.output}`);

          const tail = proc.out.slice(mark);
          assert.match(tail, /\x1b\]133;D;130;nest=1\x07/,
            'the far shell answered our ^C with a TAGGED D;130, the pair the nested release waits on — '
            + 'an untagged one is the local shell\'s and must not release');
          assert.match(tail, /\x1b\]133;A;nest=1\x07/, 'and a tagged prompt after it');

          assert.ok(tail.includes(`133;C;${REMOTE_HELLO_B64};nest=1`),
            'the install line arrived WHOLE: its own hello mark is the far side acting on it, and a line '
            + 'that lost its sacrificial leading byte leaves _cxp mangled and emits nothing. Read here rather '
            + `than off the echo, which zsh's line editor redraws and wraps\n--- out ---\n${tail.slice(0, 2000)}`);

          const r2 = await execAndWait(h, 'seat', 'false', 2);
          assert.strictEqual(r2.inside, farLine);
          assert.strictEqual(h.results[1].status, 'ok');
          assert.strictEqual(h.results[1].record.exitCode, 1,
            'a failing far command reports ITS status, not the session\'s');
        } finally { await h.dispose(); }
      });

    test(`${localName} → ${farName}: exit ends the session once, and the next local command is ordinary`,
      { skip: !pty ? 'node-pty unavailable' : false, timeout: 90000 }, async () => {
        const h = harness(localPath);
        try {
          const proc = await openSeat(h, 'seat');
          await openFar(h, 'seat', proc, farLine);
          await execAndWait(h, 'seat', 'echo hi', 1);

          await execAndWait(h, 'seat', 'exit 7', 2);
          const res = h.results[1];
          assert.strictEqual(res.status, 'session-ended',
            `the far shell died with the session, so there is no status of its own\n--- out ---\n${h.out()}`);
          assert.strictEqual(res.inside, farLine);
          assert.strictEqual(res.outerExit, 7,
            'the OUTER\'s code is reported because it is the only one there is — an explicit status here, '
            + 'so a 0 from some other path could not pass by accident');

          const st = h.ptys._execState('w', 'seat');
          assert.strictEqual(st.busy, false, 'the terminal is back at its local shell');
          assert.strictEqual(st.pending, null, 'and nothing is left waiting');

          const r = await execAndWait(h, 'seat', 'echo back', 3);
          assert.strictEqual(r.inside, undefined, 'a local exec after the session ends is ordinary again');
          assert.strictEqual(h.results[2].status, 'ok');
          assert.strictEqual(h.results[2].record.exitCode, 0);
          assert.ok(printed(h.results[2].record.output, 'back'),
            `the local capture is whole again\n--- captured ---\n${h.results[2].record.output}`);
        } finally { await h.dispose(); }
      });
  }
}

test('a bare exit reports 130 — the status our own interrupt left behind',
  { skip: !pty ? 'node-pty unavailable' : (LOCAL_SHELLS.length && FAR_SHELLS.length ? false : 'no shell pair'), timeout: 90000 },
  async () => {
    const h = harness(LOCAL_SHELLS[0][1]);
    try {
      const proc = await openSeat(h, 'seat');
      await openFar(h, 'seat', proc, FAR_SHELLS[0][1]);
      await execAndWait(h, 'seat', 'echo hi', 1);
      await execAndWait(h, 'seat', 'exit', 2);

      assert.strictEqual(h.results[1].status, 'session-ended');
      assert.strictEqual(h.results[1].outerExit, 130,
        'a bare `exit` returns $?, and the handshake\'s own ^C set that one prompt cycle earlier — so the '
        + 'status the agent is told is the session\'s, but it is an artefact of how we type');
      assert.strictEqual(h.ptys._execState('w', 'seat').busy, false);
    } finally { await h.dispose(); }
  });

const UNSUPPORTED = [
  ['/bin/sh (bash 3.2 on macOS)', '/bin/sh', 3, /older than 4\.4/],
  ['/bin/dash', '/bin/dash', 2, /neither bash 4\.4\+ nor zsh/],
].filter(([, p]) => present(p));

for (const [label, farPath, status, reasonRe] of UNSUPPORTED) {
  for (const [localName, localPath] of LOCAL_SHELLS.slice(0, 1)) {
    test(`${localName} → ${label}: refused by name with D;${status}, and nothing of the agent's typed`,
      { skip: !pty ? 'node-pty unavailable' : false, timeout: 90000 }, async () => {
        const h = harness(localPath);
        try {
          const proc = await openSeat(h, 'seat');
          const mark = await openFar(h, 'seat', proc, farPath);

          await execAndWait(h, 'seat', 'echo hi', 1);
          const res = h.results[0];
          assert.strictEqual(res.status, 'remote-unsupported',
            `the far shell answered the install line\n--- out ---\n${h.out()}`);
          assert.match(res.reason, reasonRe);
          assert.strictEqual(res.inside, farPath);

          const tail = proc.out.slice(mark);
          assert.ok(!printed(tail, 'hi'),
            'the command was never typed — a refusal that ran it anyway is the one failure this gate exists to prevent');
          assert.strictEqual(h.ptys._execState('w', 'seat').pending, null);
        } finally { await h.dispose(); }
      });
  }
}

test('32 concurrent far shells: every install line keeps its command word',
  { skip: !pty ? 'node-pty unavailable' : (LOCAL_SHELLS.length ? false : 'no shimmable local shell'), timeout: 180000 },
  async () => {
    const [, localPath] = LOCAL_SHELLS[0];
    const [, farLine] = FAR_SHELLS[0];
    const h = harness(localPath);
    const N = 32;
    try {
      const seats = [];
      for (let i = 0; i < N; i += 1) {
        const seat = `seat-${i}`;
        seats.push({ seat, proc: await openSeat(h, seat) });
      }
      await Promise.all(seats.map(({ seat, proc }) => openFar(h, seat, proc, farLine)));

      for (const { seat } of seats) {
        const r = h.ptys.exec('w', seat, 'echo hi');
        assert.strictEqual(r.ok, true, `${seat} accepted: ${r.code || ''} ${r.error || ''}`);
      }
      const all = await waitFor(() => h.results.length >= N, 120000);
      assert.ok(all, `every seat reported (${h.results.length}/${N})\n--- out ---\n${h.out().slice(-4000)}`);

      const bad = h.results.filter((r) => r.status !== 'ok' || !r.record || r.record.exitCode !== 0);
      assert.deepStrictEqual(bad.map((r) => `${r.status}:${r.reason || ''}`), [],
        'a truncated install line reaches no final printf, so it degrades to "no answer" — that is what a lost leading byte looks like here');
      assert.strictEqual(h.results.length, N, 'exactly one result per seat, no duplicates');

      const flat = stripAnsi(h.out());
      assert.ok(!/_cxp: (command )?not found|_cxq: (command )?not found/.test(flat),
        'a helper name that lost a byte would surface as a not-found on the far side');
    } finally { await h.dispose(); }
  });

test('the remote path was measured against at least one real pair of shells', () => {
  assert.ok(pty, 'node-pty is required for this file to mean anything');
  assert.ok(LOCAL_SHELLS.length > 0, 'no shimmable local shell found to drive');
  assert.ok(FAR_SHELLS.length > 0, 'no far shell found to nest');
  assert.ok(UNSUPPORTED.length > 0, 'neither refusal row could be measured on this machine');
});
