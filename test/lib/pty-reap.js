'use strict';

// Shared real-shell teardown for the test files that spawn one through node-pty
// (term-marks-bash.test.js, term-exec-keymap.test.js).
//
// Node's test glob is `**/test/**/*.?(c|m)js`, so this file is ALSO opened as a
// test file and reports as one passing point that executed nothing. On a FULL
// sweep that point is counted as an ordinary pass, so it is in the suite total;
// scripts/run-tests.js only discounts it on a FILTERED run, where an
// executed-nothing point would otherwise read as a green. It is the price of
// keeping the helper next to its callers; no filename under test/ avoids it.

// Is this pid still around? Signal 0 tests for existence without delivering
// anything. node-pty reaps its own child, so a shell that has exited is gone
// here rather than lingering as a zombie that would read as alive forever.
function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// End one pty and do not return until it is actually gone.
//
// node-pty's kill() -- and dispose()'s -- is SIGHUP, which a shell whose startup
// ran `trap '' HUP` ignores indefinitely. Measured against both shells these
// tests spawn: bash AND zsh each survive it, so this is not a bash-only hazard.
// A survivor holds the runner's event loop open, so the suite wedges at ~0% CPU
// AFTER the leaking test has already passed, which is the most expensive
// failure shape there is. The trap reaches the shell through whichever startup
// file the generated rc sources -- a real /etc/profile, the operator's own
// $HOME profile where a test does not redirect HOME, or a scratch profile a
// test writes deliberately.
//
// Modelled on drawer-pty's endShell, with one deliberate difference: that path
// unrefs its escalation timer because an app quit must never be held open five
// seconds for a shell that is already dead. Here the opposite is required - the
// next test spawns its own shell, so this one has to be gone BEFORE we return,
// and the escalation is therefore awaited rather than scheduled.
async function reapPty(proc, { graceMs = 2000, stepMs = 25 } = {}) {
  if (!proc) return true;
  // Read the pid up front so the escalation never depends on `proc` still being
  // resolvable -- the same defensive shape as endShell, whose 5s deferral
  // genuinely outlives its record.
  const pid = proc.pid;
  try { proc.kill(); } catch {}
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  try { process.kill(pid, 'SIGKILL'); } catch {}
  for (let i = 0; i < 40; i++) {
    if (!pidAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return !pidAlive(pid);
}

module.exports = { pidAlive, reapPty };
