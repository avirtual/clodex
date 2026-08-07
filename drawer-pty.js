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
function createDrawerPtys({ spawn, send, shell, cwdFor, scrollbackMax, env, log, setTimeout: setTimeoutFn, killPid, shimEnv, onCommand, makeMarkParser, onExecResult, vetCommand, execTimeoutMs }) {
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
  // Two minutes. Long enough for a build, short enough that a wedged command
  // does not leave an agent waiting for the rest of its life. It does NOT cancel
  // anything (see execTimedOut) — it is a deadline on the SILENCE, not on the
  // command.
  const EXEC_TIMEOUT = execTimeoutMs || 120000;
  // Ctrl-U then Ctrl-K, from code points rather than literal bytes in this
  // source: a raw control character is invisible, does not reliably survive
  // reformatting or an editor that sanitizes on save, and its loss would be
  // silent — the write would simply stop clearing the line. Same reason
  // drawer-avail builds its detector pattern from a string.
  //
  // BOTH are needed, and one is not a belt-and-braces duplicate of the other.
  // `^U` is kill-whole-line only in the EMACS keymap; zsh selects `viins`
  // automatically when $VISUAL or $EDITOR ends in vi/vim (no `bindkey -v`
  // required), and there `^U` is vi-kill-line, which kills back to where insert
  // mode was last entered — anything after the cursor, and anything before the
  // insert point, survives. `^K` is kill-line in emacs and vi-kill-eol in viins,
  // so the pair clears both directions in both keymaps and the second is a
  // harmless no-op after a successful first.
  const KILL_LINE = String.fromCharCode(0x15);
  const KILL_EOL = String.fromCharCode(0x0b);
  const ENTER = String.fromCharCode(0x0d);

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

    // The OSC 133 shim's env additions, or null on a host that could not build
    // one (non-zsh, unwritable dir). Null must stay ordinary: the shell spawns
    // unshimmed, emits no marks, and behaves exactly as it did before this
    // feature existed — reporting is the thing that degrades, never the
    // terminal.
    const extraEnv = (shimEnv && shimEnv(seat)) || null;
    // Whether THIS shell was born shimmed, remembered because the pref can be
    // toggled afterwards and the shell keeps whatever startup it got. Anything
    // asking "will a command in here report back?" must consult the shell, not
    // the current setting — a shell spawned before the pref was turned on emits
    // no marks however the checkbox reads now.
    const shimmed = !!extraEnv;

    let proc;
    try {
      proc = spawn(shellFor(), ['-l'], {
        name: 'xterm-256color',
        cols,
        rows,
        cwd,
        env: { ...(env || process.env), ...(extraEnv || {}), TERM: 'xterm-256color' },
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
    const rec = { proc, scrollback: '', cols, rows, windowId, seat: seat || null, seq: 0, shimmed, pending: null };
    // The mark parser is per SHELL, not per window: it holds the open command's
    // state, and one shared across seats would attribute one seat's output to
    // another's command. Only built for a shell that belongs to a seat — there
    // is nobody to report a seatless workspace shell's commands TO.
    // Marks are consumed by the parser but still forwarded to the renderer
    // untouched: xterm ignores an unknown OSC, and stripping them here would
    // mean two divergent copies of the same bytes.
    rec.marks = (onCommand && makeMarkParser && seat)
      ? makeMarkParser({
        onCommand: (c) => {
          // Whose command this was, decided BEFORE settle clears the record.
          // A command that is ours is delivered as the exec answer and NOT also
          // pushed to the passive reporter — both feed the same selection queue,
          // so reporting it twice hands the agent its own command as a short
          // unasked-for report and again with output.
          const mine = !!rec.pending && !foreignRecord(rec.pending, c);
          // The pending exec is settled FIRST and independently of passive
          // reporting: the agent asked for this one, so it is delivered even
          // when reporting is switched off (that pref governs the firehose the
          // operator rejected, not an answer to a question).
          settle(rec, { status: 'ok', record: c });
          // A FOREIGN command still belongs in the firehose. It is the
          // operator's own work, and suppressing it because it happened to
          // settle our pending record would lose a real passive report.
          if (!mine) { try { onCommand(seat, c); } catch {} }
        },
        // Abandonment has no passive consumer — a command the operator Ctrl-C'd
        // is not news to report, it is only news to whoever was waiting on it.
        onAbandon: (c) => { settle(rec, { status: 'abandoned', record: c }); },
      })
      : null;
    ptys.set(key, rec);

    proc.onData((data) => {
      if (rec.marks) { try { rec.marks.feed(data); } catch {} }
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
      // Before the identity guard below: a shell that died took its pending
      // command with it whether or not this record is still the live one, and
      // the waiter must hear about it either way.
      settle(rec, { status: 'shell-exit', exitCode });
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

  // Settle a shell's pending exec, if it has one, and tell the waiter. EVERY
  // path that can end a command routes here — the D mark, the abandon signal,
  // shell exit, and the seat/window kills — because the failure this whole
  // mechanism exists to prevent is an agent waiting forever on a command whose
  // ending nobody announced. A silent drop is the worst outcome; a wrong-ish
  // message is recoverable.
  //
  // Idempotent by clearing `pending` first: two paths can legitimately fire for
  // one command (a Ctrl-C at the prompt produces an abandon, and closing the
  // window right after produces an exit), and the second must be a no-op rather
  // than a second delivery.
  // The deadline timer is never cleared — it is IDENTITY-CHECKED instead
  // (`rec.pending !== p` ⇒ the command already ended). drawer-pty takes every
  // dependency by injection and its own test pins that it requires nothing, so
  // reaching for a global clearTimeout would either break that or add a second
  // seam to keep aligned with the first; an unref'd timer that wakes up once to
  // find its work done costs nothing.
  function settle(rec, outcome) {
    const p = rec.pending;
    if (!p) return false;
    rec.pending = null;
    if (!onExecResult) return true;
    // A D mark for a command that is not the one we typed. Ordinary, not exotic:
    // the operator presses Enter on `vim` at T and the shell's C mark reaches us
    // at T+ε (a PTY round trip), so an exec arriving inside that window sees
    // isBusy() false — correctly, nothing has told us yet — writes, and its bytes
    // land in vim's stdin. When vim exits, its D would otherwise be handed to the
    // agent as the answer to a command that never ran. No pre-check can close
    // that window, which is why it is caught HERE.
    //
    // A differing command is ALWAYS foreign, never a legitimate edit: the whole
    // line is written as one string, so the operator has no opportunity to edit
    // ours before it runs. We still settle (the always-answer invariant is what
    // this module exists for) — we just refuse to claim it as our result.
    const mismatch = foreignRecord(p, outcome && outcome.record);
    // `late` distinguishes "here is your output" from "here is the output of the
    // command I already told you had outrun its deadline" — the agent has by now
    // reported the timeout upstream and needs to know this supersedes it.
    const res = { ...outcome, command: p.command, late: !!p.timedOut };
    if (mismatch) res.mismatch = true;
    try { onExecResult(rec.seat, res); } catch {}
    return true;
  }

  // Did the shell report a DIFFERENT command finishing than the one we typed?
  // An empty reported command is not foreign, it is unknown — a C payload whose
  // base64 did not decode — and that already has an honest answer downstream.
  function foreignRecord(p, record) {
    const reported = String((record && record.command) || '').trim();
    return !!reported && reported !== p.command;
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

    // Run one command on a seat's own shell on that seat's behalf, and answer
    // through onExecResult when it ends. Unlike write() this NEVER spawns: a
    // seat with no terminal open is told so, because spawning one would put a
    // shell on the operator's screen that they did not ask for and run a command
    // in it before they could see it.
    //
    // Every refusal is checked HERE rather than by a caller reading a status
    // first. The gap between a check and the write is the whole hazard: a
    // foreground program can start inside it, and the command then lands in that
    // program's stdin instead of the shell's.
    exec(windowId, seat, command) {
      // Seatless is not addressable: there is nobody to answer, and the
      // workspace-wide shell has no parser (see spawnFor) so nothing would ever
      // settle. Callers derive the seat from the sender, so this is a guard on
      // the module's contract rather than on a user-supplied value.
      if (!seat) return { ok: false, code: 'no-seat' };
      const vet = vetCommand ? vetCommand(command) : { ok: true, command };
      if (!vet.ok) return { ok: false, code: 'bad-command', error: vet.error };
      const rec = ptys.get(keyFor(windowId, seat));
      if (!rec) return { ok: false, code: 'no-shell' };
      // No marks ⇒ no D ⇒ nothing would ever tell the agent this finished. Firing
      // blind and hoping is worse than refusing: the command would still RUN.
      if (!rec.shimmed || !rec.marks) return { ok: false, code: 'no-marks' };
      // A pending command that outran its deadline AND left the terminal idle
      // never got an ending and never will — its bytes were swallowed by
      // something that emits no marks. Without this the record stays set for the
      // life of the shell and every later exec answers `pending`, wedging the
      // seat's terminal permanently. The busy check below still protects the case
      // where the command really is still running.
      if (rec.pending && rec.pending.timedOut && !rec.marks.isBusy()) {
        settle(rec, { status: 'lost' });
      }
      // A command of MINE is still outstanding. Distinct from `busy` on purpose —
      // between the write and the C mark the parser is not capturing yet, so a
      // second exec in the same turn passes a busy check and would type over the
      // first.
      if (rec.pending) return { ok: false, code: 'pending', running: rec.pending.command };
      // Something is running, or a foreground program (vim, a REPL, a pager)
      // holds the terminal. Typing would go into ITS stdin.
      if (rec.marks.isBusy()) return { ok: false, code: 'busy' };

      const p = { command: vet.command, timedOut: false };
      rec.pending = p;
      try {
        // Clear the line in both directions FIRST. `isBusy()` false says no
        // command is RUNNING; it says nothing about the line editor, which may
        // hold a half-typed line the operator walked away from — appending to
        // that would run their fragment plus our command as one line, and the C
        // mark would report the COMBINED line as if it were ours.
        rec.proc.write(KILL_LINE + KILL_EOL + vet.command + ENTER);
      } catch (e) {
        rec.pending = null;
        return { ok: false, code: 'write-failed', error: String((e && e.message) || e) };
      }

      const timer = later(() => {
        // Identity, not a cleared handle: by now this record may hold a LATER
        // command, and timing that one out would be a lie about a command still
        // well inside its own deadline.
        if (rec.pending !== p || p.timedOut) return;
        p.timedOut = true;
        // The pending record deliberately SURVIVES. The command was not
        // cancelled — killing the operator's foreground process to meet our own
        // deadline would be far worse than a late answer — so this reports the
        // silence and the eventual D mark still delivers, flagged `late`.
        if (onExecResult) {
          try { onExecResult(seat, { status: 'timeout', command: p.command, afterMs: EXEC_TIMEOUT }); } catch {}
        }
      }, EXEC_TIMEOUT);
      if (timer && typeof timer.unref === 'function') timer.unref();
      return { ok: true, command: vet.command };
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
        // Before the kill, while the seat is still knowable: closing the window
        // ends any command an agent was waiting on, and the D mark that would
        // have settled it is never coming.
        settle(rec, { status: 'shell-gone', reason: 'the workspace window was closed' });
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
      settle(rec, { status: 'shell-gone', reason: 'the terminal was closed' });
      endShell(rec);
      return true;
    },

    dispose() {
      disposed = true;
      for (const id of [...ptys.keys()]) {
        const rec = ptys.get(id);
        ptys.delete(id);
        // Deliberately NOT settled. dispose() is app quit: every agent that
        // could read the answer is being killed in the same teardown, so a
        // delivery here writes into a queue nobody will drain — and on the
        // desktop path it would run during before-quit, which is the wrong place
        // to start appending files.
        rec.pending = null;
        try { rec.proc.kill(); } catch {}
      }
    },

    // Test/diagnostic read. Deliberately not exposed over IPC: the renderer gets
    // its scrollback once, from spawn().
    _count: () => ptys.size,

    // Test/diagnostic read of one shell's exec-relevant state. Separate from
    // _count because the refusal decisions above are made INSIDE exec() — this
    // exists to assert them, never for a caller to pre-check and then act on
    // (that race is the reason exec takes the decisions itself).
    _execState: (windowId, seat) => {
      const rec = ptys.get(keyFor(windowId, seat));
      if (!rec) return null;
      return {
        shimmed: rec.shimmed,
        busy: !!(rec.marks && rec.marks.isBusy()),
        pending: rec.pending ? rec.pending.command : null,
        timedOut: !!(rec.pending && rec.pending.timedOut),
      };
    },
  };
}

module.exports = { createDrawerPtys };
