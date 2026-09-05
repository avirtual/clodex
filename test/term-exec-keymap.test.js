'use strict';

// The one test in this suite that lets a REAL shell interpret what term exec
// types. Everything else pins the write with a recorder fake, which has no line
// editor and therefore agrees with whatever prefix we picked — that is how a
// sequence beginning `^U^K` stayed green through four review rounds while a
// vi-mode zsh typed it out as a literal `^K` and ran `^Kls`. A recorder can only
// confirm we send the bytes we chose; nothing but a shell can say the shell
// obeys them.
//
// It drives the real `exec()` with node-pty injected through the `spawn` seam,
// rather than re-declaring the byte here — a test carrying its own copy of the
// constant passes after someone changes drawer-pty's and reverts the property.
//
// The property: whatever is on the line when a command arrives, the shell runs
// EXACTLY that command, under any keymap the operator may be in.
//
// A second flake cause, fixed here after four unrelated tickets were reverted by
// it: a marker's TEXT always reaches the pty BEFORE the shell's end mark reaches
// the parser, so a wait that stops at the text can resolve in a window where
// `isBusy()` is still true and the exec under measurement is refused `busy`.
// Measured on this box: the window is entered on every run and is 4-5ms wide
// idle, 9-12ms under load — an exec fired at its start is refused 20 times in 20.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createDrawerPtys } = require('../drawer-pty');
const { buildTermShim } = require('../term-shim');
const { createMarkParser } = require('../term-marks');
// A real shell's output carries bracketed-paste toggles and OSC 7 cwd reports
// around the text, so a raw line never equals the marker. The app's own
// stripper, not a local regex — a private one here could drift into passing
// over escapes the product still shows the operator.
const { stripAnsi } = require('../cli/src/output');
// The real-shell teardown. node-pty kill() is SIGHUP and this file spawns
// against the operator's REAL $HOME (no `env` below), so their own profile is
// the door a `trap '' HUP` comes through -- measured surviving on both shells
// this file drives.
const { pidAlive, reapPty } = require('./lib/pty-reap');

// A shell missing from a machine is not a failure of this property. Nothing is
// skipped for being slow or flaky — a keymap answer does not vary run to run.
// Shimmable, not merely present. These rows drive the REAL mark parser (see
// runCase), so a shell the shim declines — a bash below the PS0 floor, most
// obviously /bin/bash on macOS — would spawn unshimmed and have every exec
// refused with `no-marks`, turning the whole file into a red that says nothing
// about keymaps. Resolved through buildTermShim itself rather than a version
// parse of our own, the way term-marks-bash.test.js resolves BASH: a second
// copy of the floor is how a supported shell starts being told it is not.
const SHELLS = [
  ['zsh', '/bin/zsh', { emacs: 'bindkey -e', vi: 'bindkey -v' }],
  ['bash', '/opt/homebrew/bin/bash', { emacs: 'set -o emacs', vi: 'set -o vi' }],
].filter(([, p]) => {
  try {
    if (!fs.statSync(p).isFile()) return false;
  } catch { return false; }
  const probe = fs.mkdtempSync(path.join(os.tmpdir(), 'clodex-keymap-probe-'));
  try {
    return !!buildTermShim({ dir: probe, shell: p });
  } catch { return false; } finally {
    try { fs.rmSync(probe, { recursive: true, force: true }); } catch {}
  }
});

let pty = null;
try { pty = require('node-pty'); } catch {}

// Long enough for a login shell's rc files on a loaded machine. Every wait polls
// for CONTENT and returns as soon as it appears, so a passing run costs the real
// latency (~85ms a row) and never this — it is a deadline on how long a FAILING
// row takes to give up. Measured at 4s: this file passed 9/9 alone and lost the
// bash rows inside the full suite, where a login shell competing with 4300 other
// tests needed longer than that just to reach its first prompt.
const SETTLE_MS = 20000;

function waitFor(getOut, pred, ms = SETTLE_MS) {
  return new Promise((resolve) => {
    const end = Date.now() + ms;
    const tick = () => {
      if (pred(getOut())) return resolve(true);
      if (Date.now() > end) return resolve(false);
      setTimeout(tick, 40);
    };
    tick();
  });
}

// The marker is echoed by the command itself, so seeing it means the SHELL ran
// what we sent — not that we wrote something. Split so the string never matches
// the echo of the command line as it is typed.
const MARK = ['TERMEXEC', 'RAN'].join('_');

// The readiness `exec()` actually gates on, which is NOT the one a marker's text
// proves. exec refuses `busy` off the parser's `capturing` flag, and the parser
// only clears it when the shell's end mark reaches feed() — strictly after the
// command's output, so a wait that stops at the text resolves in the gap and the
// exec is refused. It does not replace a marker-text wait, it follows one: the
// text is the guard that the shell RAN the line, a question the busy flag cannot
// answer (an idle shell that ran nothing is also not busy).
async function waitNotBusy(ptys) {
  return waitFor(() => ptys._execState('w', 'seat'), (st) => !!st && !st.busy);
}

// Split for the same reason as MARK, and it is not decoration. The readiness
// wait below matches this against everything the pty has emitted, and a
// terminal ECHOES the line as it is typed — so a marker spelled literally in
// the command is satisfied by the echo of the command rather than by its
// OUTPUT. The row then proceeds while the shell is still reading that line,
// exec()'s ^C discards the unread remainder, and the fragment left over runs:
// `set -o emacs && echo ...` surfaced as `bash: et: command not found`.
// Measured against unmodified product code: 6 losses in 280 spelled literally,
// 0 in 450 split.
const KEYMAP_MARK = ['KEYMAP', 'SET'].join('_');

async function runCase({ shellPath, keymapCmd, prefill, armHup, graceMs }) {
  const out = { s: '' };
  let proc = null;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clodex-keymap-'));
  const ptys = createDrawerPtys({
    spawn: (file, args, opts) => {
      proc = pty.spawn(file, args, opts);
      proc.onData((d) => { out.s += d; });
      return proc;
    },
    send: () => {},
    shell: shellPath,
    cwdFor: () => process.env.HOME || '/',
    // THE REAL SHIM AND THE REAL PARSER, as engine.js wires them. This file
    // once stubbed both (`feed(){}`) on the grounds that its question is about
    // bytes reaching the line editor rather than about marks — but the readiness
    // signal exec() waits on before typing IS a mark, so stubbing it meant these
    // rows measured a handshake the product does not use. Eight of the nine
    // recorded flakes were rows in this file, and none of them could reach the
    // mark-based ack while it was stubbed out.
    shimEnv: () => buildTermShim({ dir, shell: shellPath }),
    makeMarkParser: createMarkParser,
    onCommand: () => {},
    log: { info() {}, warn() {}, error() {} },
  });

  try {
    // Wide enough that the echoed command line cannot WRAP. A wrap injects
    // `\r` or ` \r` mid-line, and the intact-write assertion below reads the
    // echo — this ticket exists because of a false rejection, so the harness
    // must not manufacture one of its own.
    ptys.spawn('w', 'seat', { cols: 200, rows: 24 });
    assert.ok(proc, 'node-pty spawned');
    // ENTER: an unshimmed shell refuses every exec with `no-marks`, and every
    // assertion below would then be measuring that refusal rather than a keymap.
    assert.strictEqual(ptys._execState('w', 'seat').shimmed, true,
      'ENTER: the shell was born shimmed');
    // Put the shell in the keymap under test and prove it got there before
    // measuring anything — an rc file that had not run yet would silently make
    // this an emacs case wearing a vi label, and every vi row would pass.
    // The shell concatenates the marker, so the bytes typed on the line never
    // contain it and only the OUTPUT can satisfy the wait below.
    proc.write(`${keymapCmd} && echo KEYMAP''_SET\r`);
    const ready = await waitFor(() => out.s, (s) => s.includes(KEYMAP_MARK));
    assert.ok(ready, `shell reached ${keymapCmd}`);
    assert.ok(await waitNotBusy(ptys),
      `the parser saw the keymap command's end mark\n--- output ---\n${out.s}`);

    // A shell that IGNORES SIGHUP, for the teardown's own regression test at
    // the foot of this file. Armed by TYPING it rather than through a profile:
    // this file spawns against the operator's real $HOME by design (runCase
    // passes no `env`), and a test that wrote a profile there would be editing
    // the developer's own dotfiles in order to measure itself.
    if (armHup) {
      out.s = '';
      proc.write(`trap '' HUP; trap; echo TRAP''_LISTED\r`);
      const listed = await waitFor(() => out.s, (s) => s.includes('TRAP_LISTED'));
      assert.ok(listed, `the shell answered the trap listing\n--- output ---\n${out.s}`);
      // ENTER: the trap has to be INSTALLED, not merely typed. An unarmed shell
      // dies on the first HUP and would then pass against the very teardown this
      // exists to reject. Bare `trap` lists in both shells this file drives; they
      // spell the signal differently (zsh `HUP`, bash `SIGHUP`), and the ECHO of
      // the typed line cannot satisfy this because it carries no `--`.
      assert.match(stripAnsi(out.s), /SIG_IGN|trap -- '' (SIG)?HUP/,
        `ENTER: the shell really is ignoring HUP\n--- trap ---\n${out.s}`);
      // ENTER: without a live pid there is nothing for the teardown to reap, and
      // 'the process is not alive' is trivially true of a shell that never
      // spawned - exactly the shape that passes while measuring nothing.
      assert.ok(pidAlive(proc.pid), 'ENTER: the shell is running before teardown');
      assert.ok(await waitNotBusy(ptys),
        `the parser saw the trap listing's end mark\n--- output ---\n${out.s}`);
    }

    // A draft the operator walked away from. Left with the cursor moved back
    // into it: `^U` alone passes a cursor-at-end probe under vi mode (viins
    // binds it to the BACKWARD-only vi-kill-line) and loses the tail here.
    if (prefill) {
      // Wait for the WHOLE draft to echo, not a prefix: the tail is the part a
      // backward-only kill leaves behind, so a test that proceeds before it is
      // on the line measures a shorter draft than it claims to.
      proc.write(prefill);
      const drafted = await waitFor(() => out.s, (s) => stripAnsi(s).includes(prefill));
      assert.ok(drafted, 'ENTER: the draft is on the line before anything clears it');
      // Cursor back INTO the draft. Under zsh viins ESC is itself bound
      // (vi-cmd-mode) and `^[[D` only wins as the longer match, so the shell
      // holds the ESC for KEYTIMEOUT (0.4s) deciding between them. Writing the
      // clear immediately after resolves that ambiguity the wrong way and the
      // cursor never moves — which silently turns this into the cursor-at-end
      // case, where `^U` passes for a reason that has nothing to do with the
      // property. Measured: without this wait, `^U` alone survives here.
      proc.write('\x1b[D\x1b[D');
      await new Promise((r) => setTimeout(r, 600));
    }

    out.s = '';
    const res = ptys.exec('w', 'seat', `echo ${MARK}`);
    assert.strictEqual(res.ok, true, `exec accepted: ${res.code || ''} ${res.error || ''}`);

    // The marker on a line of its OWN, which is the echoed output rather than
    // the command line: a shell that ran `junk_draftecho TERMEXEC_RAN` prints
    // the marker too, on a "command not found" line.
    const ran = await waitFor(() => out.s, (s) =>
      stripAnsi(s).split(/\r?\n/).some((l) => l.trim() === MARK));
    return { ran, out: out.s, pid: proc && proc.pid };
  } finally {
    try { ptys.dispose(); } catch {}
    // The boolean is the ONLY witness to a pid that outlived even SIGKILL: that
    // survivor holds the runner's event loop open, so the suite wedges at ~0%
    // CPU long after this row has passed, naming nothing. Reported rather than
    // asserted — a throw here would mask whatever failure sent us into finally.
    try { if (!(await reapPty(proc, { graceMs }))) console.error(`reapPty: pid ${proc && proc.pid} survived SIGKILL`); } catch {}
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

for (const [name, shellPath, keymaps] of SHELLS) {
  for (const [km, keymapCmd] of Object.entries(keymaps)) {
    for (const prefill of ['', 'junk_draft_xyz']) {
      const label = prefill ? 'with a half-typed line' : 'on an empty line';
      test(`${name} in ${km} mode runs exactly the command, ${label}`,
        { skip: !pty ? 'node-pty unavailable' : false, timeout: 90000 }, async () => {
          const { ran, out } = await runCase({ shellPath, keymapCmd, prefill });
          // Two DIFFERENT failures, separated. A swallowed first byte and a
          // shell that never received the line both leave `ran` false, and
          // before this they were indistinguishable in the output — every
          // occurrence of the t419 race read as "the shell ran nothing", which
          // is what sent four agents looking in the wrong place.
          //
          // The echo of the command line is the evidence that the WRITE landed
          // intact, independently of whether it then ran: a shell that got
          // `cho ...` echoes `cho ...`, so a truncated echo names the race
          // directly. Checked before `ran` so it is the message that surfaces.
          // Whitespace collapsed on BOTH sides before comparing. cols:200 above
          // should already prevent a wrap; this is the second belt, because a
          // wrap would inject `\r` or ` \r` into the echo and fail an assertion
          // whose whole message says "corrupted write" — manufacturing exactly
          // the false rejection this ticket exists to stop.
          const flat = (s) => s.replace(/\s+/g, ' ');
          const typed = `echo ${MARK}`;
          assert.ok(flat(stripAnsi(out)).includes(flat(typed)),
            `the write was CORRUPTED in transit — the shell echoed something other than `
            + `\`${typed}\`, which is the swallowed-byte race, not a shell that ignored us`
            + `\n--- output ---\n${out}`);
          // ENTER: the marker means the shell EXECUTED it. Without this the
          // negative checks below are all true of a shell that ran nothing.
          assert.ok(ran, `ENTER: the shell ran the command\n--- output ---\n${out}`);
          assert.ok(!/command not found/.test(out),
            `the shell was handed something other than the command\n--- output ---\n${out}`);
          if (prefill) {
            assert.ok(!out.includes('junk_draft'),
              `the operator's draft survived and joined the command\n--- output ---\n${out}`);
          }
        });
    }
  }
}

// The teardown's own regression test, and the reason it reaps rather than
// kills. node-pty's kill() is SIGHUP; a shell ignoring it survives, holds this
// runner's event loop open, and the suite wedges at ~0% CPU AFTER this file has
// already passed. This file is the more exposed of the two that spawn real
// shells: it passes no `env` to createDrawerPtys, so drawer-pty falls back to
// process.env and the generated rc sources the operator's genuine $HOME
// profile. Latent, not live -- it needs a developer who traps HUP.
//
// Run for EVERY shell this file drives, because the two do not answer alike:
// `trap -p HUP` is a bashism zsh does not implement, and the bare `trap` both
// accept spells the signal `HUP` in zsh and `SIGHUP` in bash. Measured: both
// survive a SIGHUP once armed, so the property is not bash-only.
for (const [name, shellPath, keymaps] of SHELLS) {
  test(`a ${name} that ignores SIGHUP is still gone once the teardown returns`,
    { skip: !pty ? 'node-pty unavailable' : false, timeout: 90000 }, async () => {
      let pid = null;
      try {
        // graceMs is 150 rather than the 2000 default: this shell is DESIGNED
        // never to die on HUP, so the grace is time the suite pays on every
        // green run to wait for something that cannot happen. A cooperative
        // shell dies in milliseconds, and 150ms is still six poll steps.
        ({ pid } = await runCase({
          shellPath, keymapCmd: keymaps.emacs, prefill: '', armHup: true, graceMs: 150,
        }));
        // The ENTER guards live inside runCase's arming block: by here the
        // shell has been proven alive AND proven to be ignoring HUP.
        assert.ok(pid, 'ENTER: runCase reported a pid to observe');
        assert.strictEqual(pidAlive(pid), false,
          `the teardown escalated past SIGHUP and reaped pid ${pid}; `
          + 'a survivor here holds the runner open and wedges the whole suite');
      } finally {
        // Belt and braces: if the assertion above failed, the survivor is still
        // running and would outlive this process as an orphan.
        if (pid && pidAlive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch {} }
      }
    });
}

// A machine with neither shell would otherwise report a green file that
// measured nothing at all.
test('the keymap property was measured against at least one real shell', () => {
  assert.ok(SHELLS.length > 0, 'no shell found to test against');
  assert.ok(pty, 'node-pty is required for this file to mean anything');
});
