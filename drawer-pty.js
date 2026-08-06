'use strict';
// drawer-pty.js — the drawer's terminal tab, main side. A workbench terminal
// is a NEW OBJECT, not a session, and the distinction is the whole design:
//
//   it has no entry in `sessions`, no `~/.clodex/run/<name>` registry file, no
//   agent socket, no sidebar row, no persistence record. It is invisible to
//   `[agent:who]` and does not ride `session:list`.
//
// So this file deliberately does NOT reuse session-manager: the session
// machinery (naming, registry, transcript watching, injection, resume) is the
// wrong 90%, and reaching for it is what would quietly make a workbench
// terminal discoverable. The privacy claim for bash SESSIONS is unchanged by
// this file precisely because nothing here touches them — a workbench terminal
// is readable by construction (the operator opened a console to look at it),
// and nothing that is private today becomes readable.
//
// Electron-free by construction: node-pty and the window→renderer send both
// arrive as injected seams, which is also what makes the ring and the lifecycle
// unit-testable without standing up a window.

// One terminal per (WINDOW, SEAT). Keyed by both because the two identities do
// different jobs and collapsing them is what the per-window version got wrong:
// the seat decides WHICH shell (and its cwd — a seat's shell in another seat's
// directory is wrong most of the time), the window decides WHERE ITS OUTPUT
// GOES, since a workspace is a window and that is what `send` can address.
//
// A seatless key is still valid and is the workspace-wide shell: the drawer
// opened with no session selected has nowhere else to belong.
function createDrawerPtys({ spawn, send, shell, cwdFor, scrollbackMax, env, log, setTimeout: setTimeoutFn, killPid }) {
  const ptys = new Map(); // key(windowId, seat) -> { proc, scrollback, cols, rows, windowId, seat }

  // NUL joins the two halves because it is the one byte neither can contain: a
  // session name is [a-zA-Z0-9._-]{1,64} and a workspace id is minted, but a
  // separator either could hold would let one pair alias another's shell.
  const keyFor = (windowId, seat) => `${windowId}\u0000${seat || ''}`;
  const MAX = scrollbackMax || 256 * 1024;
  const logger = log || { info() {}, warn() {}, error() {} };
  // Injected so the kill escalation is assertable without a five-second test.
  const later = setTimeoutFn || setTimeout;
  const killProcess = killPid || ((pid, sig) => process.kill(pid, sig));
  let disposed = false;

  function shellFor() {
    // $SHELL, then the platform default. A login shell (`-l`) is deliberate:
    // the operator's aliases and PATH are the point of a workbench terminal,
    // and an aws-cli or nvm-shimmed binary missing from a non-login PATH is
    // exactly the debugging case this tab exists for.
    return shell || (env && env.SHELL) || process.env.SHELL || '/bin/zsh';
  }

  function spawnFor(windowId, seat, opts) {
    if (disposed) return null;
    const key = keyFor(windowId, seat);
    const existing = ptys.get(key);
    if (existing) return existing;
    // Everything below builds a NEW shell; `fresh` on the way out is what tells
    // the renderer whether the scrollback it is being handed is a replay of a
    // shell it already drew (do not write it again) or a shell it has never
    // seen.

    const cols = clampDim(opts && opts.cols, 80);
    const rows = clampDim(opts && opts.rows, 24);
    // The SEAT is what cwdFor resolves against when there is one — a shell that
    // opens in another seat's directory is the defect this keying fixes, and
    // passing only the window would reintroduce it one layer down.
    const cwd = (cwdFor && cwdFor(windowId, seat)) || process.env.HOME || '/';

    let proc;
    try {
      proc = spawn(shellFor(), ['-l'], {
        name: 'xterm-256color',
        cols,
        rows,
        cwd,
        env: { ...(env || process.env), TERM: 'xterm-256color' },
      });
    } catch (e) {
      logger.warn('wterm', `spawn failed: ${e.message}`);
      return { error: e.message };
    }

    // Monotonic per shell, bumped on every data event and snapshotted by
    // spawn(). It is what lets the renderer tell whether a byte it received live
    // is ALREADY inside the scrollback it was handed: the two arrive over
    // different IPC paths, so their relative order is not guaranteed and a
    // seq-less renderer must either double-print the overlap or drop the tail.
    const rec = { proc, scrollback: '', cols, rows, windowId, seat: seat || null, seq: 0 };
    ptys.set(key, rec);

    proc.onData((data) => {
      rec.scrollback += data;
      rec.seq += 1;
      if (rec.scrollback.length > MAX) rec.scrollback = rec.scrollback.slice(-MAX);
      // The SEAT rides along so the renderer can drop bytes for a shell that is
      // no longer on screen. Without it, output from a background seat's shell
      // would be written into whichever terminal happens to be mounted — the
      // scrollbacks would interleave and neither would be recoverable.
      send(windowId, 'wterm:data', data, rec.seat, rec.seq);
    });

    proc.onExit(({ exitCode }) => {
      // Identity, not key. A shell whose foreground child traps SIGHUP outlives
      // the kill() that closed its window; if the operator reopens that
      // workspace (same id) a successor is spawned at this same key, and a
      // delete-by-key here would unmap the LIVE one — unreachable by
      // write/resize/kill, invisible to dispose(), and left running after quit.
      if (ptys.get(key) !== rec) return;
      // Drop the record BEFORE announcing: the renderer respawns when it learns
      // the shell died, and a record still in the map hands back the corpse.
      ptys.delete(key);
      send(windowId, 'wterm:data', `\r\n\x1b[2m[shell exited: ${exitCode}]\x1b[0m\r\n`, rec.seat);
    });

    return rec;
  }

  // Kill one shell, with the SIGHUP→SIGKILL escalation. Factored out when kill()
  // became a loop: three call sites now end a shell, and an escalation that
  // exists at only some of them is the leak it was written to prevent.
  function endShell(rec) {
    // Read the pid BEFORE anything else — the escalation below runs five
    // seconds later, when nothing else can resolve this proc.
    const pid = rec.proc.pid;
    try { rec.proc.kill(); } catch {}
    // pty.kill() is SIGHUP, which a foreground child trapping or ignoring HUP
    // survives indefinitely. Same 5s escalation as session-manager's
    // kill/archive paths. `unref` so a quit is never held open for five
    // seconds waiting on a shell that is already gone.
    const t = later(() => { try { killProcess(pid, 'SIGKILL'); } catch {} }, 5000);
    if (t && typeof t.unref === 'function') t.unref();
  }

  // A PTY dimension of 0 makes the child's ioctl meaningless and some programs
  // divide by it; the renderer legitimately reports 0 when it measures a pane
  // mid-transition.
  function clampDim(n, fallback) {
    const v = Math.floor(Number(n));
    return Number.isFinite(v) && v > 0 ? v : fallback;
  }

  return {
    // Lazily spawned on first activation, and idempotent: the tenant calls this
    // on every onShow, and the second call must return the SAME shell with its
    // scrollback, not a new one over the top of it.
    spawn(windowId, seat, opts) {
      const had = ptys.has(keyFor(windowId, seat));
      const rec = spawnFor(windowId, seat, opts);
      if (!rec) return { ok: false, error: 'drawer terminals are unavailable on this host' };
      if (rec.error) return { ok: false, error: rec.error };
      // `seat` is echoed so the renderer can tell whether the shell it was
      // handed is the one it asked for: a switch resolving after a later switch
      // would otherwise paint the wrong seat's scrollback.
      return { ok: true, fresh: !had, scrollback: rec.scrollback, cols: rec.cols, rows: rec.rows, seat: rec.seat, seq: rec.seq };
    },

    write(windowId, seat, data) {
      const rec = ptys.get(keyFor(windowId, seat));
      if (!rec || typeof data !== 'string') return false;
      try { rec.proc.write(data); return true; } catch { return false; }
    },

    resize(windowId, seat, cols, rows) {
      const rec = ptys.get(keyFor(windowId, seat));
      if (!rec) return false;
      const c = clampDim(cols, rec.cols);
      const r = clampDim(rows, rec.rows);
      if (c === rec.cols && r === rec.rows) return true; // no SIGWINCH for a no-op
      rec.cols = c;
      rec.rows = r;
      try { rec.proc.resize(c, r); return true; } catch { return false; }
    },

    // Window close. Not "archive": a workbench terminal has no record to keep,
    // so closing the window it belongs to ends it — and since the keying went
    // per-seat, that is now EVERY shell in the window, not one. A loop rather
    // than a single lookup is the whole fix: the pre-seat version killed one
    // shell per window because there could only be one, and leaving it would
    // strand every seat's shell but the first as an unreachable orphan.
    kill(windowId) {
      let killed = false;
      for (const [k, rec] of [...ptys]) {
        if (rec.windowId !== windowId) continue;
        ptys.delete(k);
        endShell(rec);
        killed = true;
      }
      return killed;
    },

    // A seat went away (deleted, or archived — its shell has no record to
    // resume from either way). Nothing else reaps this: window close is the
    // wrong event, and without it a long-lived workspace accumulates a shell per
    // seat the operator can no longer reach.
    killSeat(windowId, seat) {
      const key = keyFor(windowId, seat);
      const rec = ptys.get(key);
      if (!rec) return false;
      ptys.delete(key);
      endShell(rec);
      return true;
    },

    dispose() {
      disposed = true;
      for (const id of [...ptys.keys()]) {
        const rec = ptys.get(id);
        ptys.delete(id);
        try { rec.proc.kill(); } catch {}
      }
    },

    // Test/diagnostic read. Deliberately not exposed over IPC: the renderer gets
    // its scrollback once, from spawn().
    _count: () => ptys.size,
  };
}

module.exports = { createDrawerPtys };
