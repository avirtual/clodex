// One-shot ssh command runner — the shared transport for the peer-deploy
// wizard's probe and deploy steps (and, later, update-in-place). Runs a script
// on a remote box over ssh WITHOUT a managed tunnel: unlike peer-tunnel.js
// (a long-lived `ssh -N -L` forward this supervises), sshRun opens ssh, pipes a
// script to `bash -s` on its stdin, streams stdout back line-by-line, and
// resolves once the remote command exits.
//
// Auth is key-based only (BatchMode=yes) — Clodex never proxies an interactive
// password/hostkey prompt, so a misconfigured box FAILS FAST instead of hanging
// a wizard on a hidden prompt. StrictHostKeyChecking=accept-new keeps first
// contact friction-free (TOFU — the same trust move the tunnel makes) while
// still failing loudly on a CHANGED key. ConnectTimeout bounds the dial; a
// separate wall-clock timeout bounds the whole run (a deploy that wedges
// mid-step is killed, not left hanging).
//
// spawnFn is injectable for tests (same DI seam as peer-tunnel.js); production
// uses child_process.spawn. Resolves { code, signal, stdout, stderr, timedOut }
// — a non-zero exit or a timeout is a normal outcome the caller classifies, not
// a throw; only a spawn failure (no ssh binary) rejects.

'use strict';

const { spawn } = require('child_process');

// ssh's own connection/auth failure exit code. Distinguishes "ssh couldn't
// reach the box" from a remote command that ran and exited non-zero — the
// probe leans on this to tell ssh-fail from a live-but-non-clodex box.
const SSH_EXIT = 255;

const SSH_ARGS = [
  '-o', 'BatchMode=yes',
  '-o', 'ConnectTimeout=10',
  '-o', 'StrictHostKeyChecking=accept-new',
  '-o', 'ServerAliveInterval=15',
  '-o', 'ServerAliveCountMax=2',
];

// Run `script` on `host` via `ssh … bash -s`. Options:
//   timeoutMs  wall-clock cap on the whole run (default 120s); on expiry the
//              child is SIGKILLed and the result carries timedOut:true, code:null.
//   onLine     called with each COMPLETE stdout line (newline-stripped) as it
//              arrives — this is the deploy marker stream. A trailing partial
//              line (no final newline) is flushed on exit.
//   spawnFn    DI seam for tests.
function sshRun(host, script, { timeoutMs = 120000, onLine = null, spawnFn = spawn } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      // 'bash -s' as a single argv element: ssh concatenates remote args with
      // spaces into one command string for the login shell, so this reaches the
      // box as `bash -s` reading our script from stdin.
      child = spawnFn('ssh', [...SSH_ARGS, host, 'bash -s'], { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      return reject(e);
    }

    let stdout = '';
    let stderr = '';
    let lineBuf = '';
    let timedOut = false;
    let done = false;

    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch {}
    }, timeoutMs);

    const emitLines = (chunk) => {
      lineBuf += chunk;
      let idx;
      while ((idx = lineBuf.indexOf('\n')) >= 0) {
        const line = lineBuf.slice(0, idx);
        lineBuf = lineBuf.slice(idx + 1);
        try { onLine(line); } catch {}
      }
    };

    if (child.stdout) child.stdout.on('data', (chunk) => {
      const s = chunk.toString();
      stdout += s;
      if (onLine) emitLines(s);
    });
    if (child.stderr) child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

    child.on('error', (e) => {          // spawn failure (no ssh binary, etc.)
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(e);
    });

    child.on('exit', (code, signal) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      // Flush a trailing partial line so a marker without a final newline (or a
      // one-line script) still reaches onLine.
      if (onLine && lineBuf.length) { try { onLine(lineBuf); } catch {} }
      resolve({ code: timedOut ? null : code, signal: signal || null, stdout, stderr, timedOut });
    });

    // Feed the script over stdin, then close it so `bash -s` runs and exits.
    try {
      if (child.stdin) { child.stdin.write(script); child.stdin.end(); }
    } catch { /* the exit/error handlers own the outcome */ }
  });
}

module.exports = { sshRun, SSH_ARGS, SSH_EXIT };
