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

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

const { createDrawerPtys } = require('../drawer-pty');
// A real shell's output carries bracketed-paste toggles and OSC 7 cwd reports
// around the text, so a raw line never equals the marker. The app's own
// stripper, not a local regex — a private one here could drift into passing
// over escapes the product still shows the operator.
const { stripAnsi } = require('../cli/src/output');

// A shell missing from a machine is not a failure of this property. Nothing is
// skipped for being slow or flaky — a keymap answer does not vary run to run.
const SHELLS = [
  ['zsh', '/bin/zsh', { emacs: 'bindkey -e', vi: 'bindkey -v' }],
  ['bash', '/opt/homebrew/bin/bash', { emacs: 'set -o emacs', vi: 'set -o vi' }],
].filter(([, p]) => { try { return fs.statSync(p).isFile(); } catch { return false; } });

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

async function runCase({ shellPath, keymapCmd, prefill }) {
  const out = { s: '' };
  let proc = null;
  const ptys = createDrawerPtys({
    spawn: (file, args, opts) => {
      proc = pty.spawn(file, args, opts);
      proc.onData((d) => { out.s += d; });
      return proc;
    },
    send: () => {},
    shell: shellPath,
    cwdFor: () => process.env.HOME || '/',
    // No shim: this test is about the bytes reaching the line editor, and the
    // OSC 133 marks are a separate mechanism with their own tests. exec()
    // refuses without marks, so the parser is stubbed busy-free below.
    shimEnv: () => ({ env: { TERM_EXEC_KEYMAP_TEST: '1' }, args: ['-l'] }),
    makeMarkParser: () => ({ feed() {}, isBusy: () => false, _state: () => ({}) }),
    onCommand: () => {},
    log: { info() {}, warn() {}, error() {} },
  });

  try {
    ptys.spawn('w', 'seat', { cols: 80, rows: 24 });
    assert.ok(proc, 'node-pty spawned');
    // Put the shell in the keymap under test and prove it got there before
    // measuring anything — an rc file that had not run yet would silently make
    // this an emacs case wearing a vi label, and every vi row would pass.
    proc.write(`${keymapCmd} && echo KEYMAP_SET\r`);
    const ready = await waitFor(() => out.s, (s) => s.includes('KEYMAP_SET'));
    assert.ok(ready, `shell reached ${keymapCmd}`);

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
    return { ran, out: out.s };
  } finally {
    try { ptys.dispose(); } catch {}
    try { if (proc) proc.kill(); } catch {}
  }
}

for (const [name, shellPath, keymaps] of SHELLS) {
  for (const [km, keymapCmd] of Object.entries(keymaps)) {
    for (const prefill of ['', 'junk_draft_xyz']) {
      const label = prefill ? 'with a half-typed line' : 'on an empty line';
      test(`${name} in ${km} mode runs exactly the command, ${label}`,
        { skip: !pty ? 'node-pty unavailable' : false, timeout: 90000 }, async () => {
          const { ran, out } = await runCase({ shellPath, keymapCmd, prefill });
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

// A machine with neither shell would otherwise report a green file that
// measured nothing at all.
test('the keymap property was measured against at least one real shell', () => {
  assert.ok(SHELLS.length > 0, 'no shell found to test against');
  assert.ok(pty, 'node-pty is required for this file to mean anything');
});
