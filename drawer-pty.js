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

// One terminal per WINDOW, keyed by the window id. A workspace is a window, so
// this is "one workbench terminal per workspace" without the module needing to
// know what a workspace is.
function createDrawerPtys({ spawn, send, shell, cwdFor, scrollbackMax, env, log, setTimeout: setTimeoutFn, killPid }) {
  const ptys = new Map(); // windowId -> { proc, scrollback, cols, rows }
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

  function spawnFor(windowId, opts) {
    if (disposed) return null;
    const existing = ptys.get(windowId);
    if (existing) return existing;
    // Everything below builds a NEW shell; `fresh` on the way out is what tells
    // the renderer whether the scrollback it is being handed is a replay of a
    // shell it already drew (do not write it again) or a shell it has never
    // seen.

    const cols = clampDim(opts && opts.cols, 80);
    const rows = clampDim(opts && opts.rows, 24);
    const cwd = (cwdFor && cwdFor(windowId)) || process.env.HOME || '/';

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

    const rec = { proc, scrollback: '', cols, rows, windowId };
    ptys.set(windowId, rec);

    proc.onData((data) => {
      rec.scrollback += data;
      if (rec.scrollback.length > MAX) rec.scrollback = rec.scrollback.slice(-MAX);
      send(windowId, 'wterm:data', data);
    });

    proc.onExit(({ exitCode }) => {
      // Identity, not key. A shell whose foreground child traps SIGHUP outlives
      // the kill() that closed its window; if the operator reopens that
      // workspace (same id) a successor is spawned at this same key, and a
      // delete-by-key here would unmap the LIVE one — unreachable by
      // write/resize/kill, invisible to dispose(), and left running after quit.
      if (ptys.get(windowId) !== rec) return;
      // Drop the record BEFORE announcing: the renderer respawns when it learns
      // the shell died, and a record still in the map hands back the corpse.
      ptys.delete(windowId);
      send(windowId, 'wterm:data', `\r\n\x1b[2m[shell exited: ${exitCode}]\x1b[0m\r\n`);
    });

    return rec;
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
    spawn(windowId, opts) {
      const had = ptys.has(windowId);
      const rec = spawnFor(windowId, opts);
      if (!rec) return { ok: false, error: 'drawer terminals are unavailable on this host' };
      if (rec.error) return { ok: false, error: rec.error };
      return { ok: true, fresh: !had, scrollback: rec.scrollback, cols: rec.cols, rows: rec.rows };
    },

    write(windowId, data) {
      const rec = ptys.get(windowId);
      if (!rec || typeof data !== 'string') return false;
      try { rec.proc.write(data); return true; } catch { return false; }
    },

    resize(windowId, cols, rows) {
      const rec = ptys.get(windowId);
      if (!rec) return false;
      const c = clampDim(cols, rec.cols);
      const r = clampDim(rows, rec.rows);
      if (c === rec.cols && r === rec.rows) return true; // no SIGWINCH for a no-op
      rec.cols = c;
      rec.rows = r;
      try { rec.proc.resize(c, r); return true; } catch { return false; }
    },

    // Window close. Not "archive": a workbench terminal has no record to keep,
    // so closing the window it belongs to ends it.
    kill(windowId) {
      const rec = ptys.get(windowId);
      if (!rec) return false;
      // Read the pid BEFORE the delete — the escalation below runs five seconds
      // later, when nothing else can resolve this proc.
      const pid = rec.proc.pid;
      ptys.delete(windowId);
      try { rec.proc.kill(); } catch {}
      // pty.kill() is SIGHUP, which a foreground child trapping or ignoring HUP
      // survives indefinitely. Same 5s escalation as session-manager's
      // kill/archive paths. `unref` so a quit is never held open for five
      // seconds waiting on a shell that is already gone.
      const t = later(() => { try { killProcess(pid, 'SIGKILL'); } catch {} }, 5000);
      if (t && typeof t.unref === 'function') t.unref();
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
