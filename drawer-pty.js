'use strict';
// drawer-pty.js — the drawer's terminal tab, main side. A workbench terminal is not
// a session: no `sessions` entry, no registry file, no agent socket, no persistence
// record, invisible to `[agent:who]`. Reusing session-manager would make one
// discoverable, so this file requires nothing.

// Keyed by (WINDOW, SEAT): collapsing the two gives a seat a shell in another
// seat's directory. A seatless key is the workspace-wide shell.
function createDrawerPtys({ spawn, send, shell, cwdFor, scrollbackMax, env, log, setTimeout: setTimeoutFn, killPid, shimEnv, onCommand, makeMarkParser, onExecResult, vetCommand, execTimeoutMs, onOutput, onShellEnd }) {
  const ptys = new Map(); // key(windowId, seat) -> { proc, scrollback, cols, rows, windowId, seat }

  // NUL is the one byte neither half can contain; any other separator would let one
  // pair alias another's shell.
  const keyFor = (windowId, seat) => `${windowId}\u0000${seat || ''}`;
  const MAX = scrollbackMax || 256 * 1024;
  const logger = log || { info() {}, warn() {}, error() {} };
  const later = setTimeoutFn || setTimeout;
  // The `> 0` lives in the default because that is the arm production takes —
  // engine.js injects no killPid. A non-positive pid is not an id to process.kill:
  // -1 signals every process the user may signal, 0 our own process group.
  const killProcess = killPid || ((pid, sig) => {
    if (!(pid > 0)) {
      logger.warn('drawer', `refusing SIGKILL: pid is ${pid}, which would broadcast rather than target`);
      return;
    }
    process.kill(pid, sig);
  });
  let disposed = false;
  // A deadline on the SILENCE, not on the command: it cancels nothing.
  const EXEC_TIMEOUT = execTimeoutMs || 120000;
  // From a code point, not a literal byte: an editor that sanitizes on save would
  // silently drop it. ^C, never ^U/^K — under `bindkey -v` zsh binds ^K to
  // self-insert, so the shell ran `^Kls`. Measured on real zsh and bash.
  const ABANDON_LINE = String.fromCharCode(0x03);
  const ENTER = String.fromCharCode(0x0d);
  // Armed only while the shell is silent; the first byte makes it inert for good.
  const ABANDON_ACK_MS = 250;
  // One repeat of the abandon, and only into a shell that answered the first with a
  // redraw carrying no interrupt status. Must stay under ABANDON_MAX_MS with room to
  // spare: its whole purpose is to convert the blind write into an acked one, so the
  // elicited prompt has to arrive before the cap fires (measured: ~1ms after the
  // repeat). Unlike the two below it types nothing, so it is not a backstop.
  const ABANDON_NUDGE_MS = 400;
  // Later than any plausible flush, and not evidence that the interrupt landed.
  const ABANDON_MAX_MS = 1000;
  // An A mark reporting 130 proves only that the last command to finish exited
  // 128+SIGINT: `$?` is latched and re-reports on every prompt cycle until a command
  // runs, so a stale or in-flight pair can arrive inside our race window. The clocks
  // above are the only thing standing behind that.

  function shellFor() {
    return shell || (env && env.SHELL) || process.env.SHELL || '/bin/zsh';
  }

  // bash cannot be shimmed and stay a login shell (a login bash ignores `--rcfile`),
  // so its shim hands back a non-login argv; zsh's shim keeps `-l`.
  const DEFAULT_ARGS = ['-l'];

  function spawnFor(windowId, seat, opts) {
    if (disposed) return null;
    const key = keyFor(windowId, seat);
    const existing = ptys.get(key);
    if (existing) return existing;

    const cols = clampDim(opts && opts.cols, 80);
    const rows = clampDim(opts && opts.rows, 24);
    const cwd = (cwdFor && cwdFor(windowId, seat)) || process.env.HOME || '/';

    // A null shim must stay ordinary: reporting degrades, never the terminal.
    // `{ env, args }`, not an env map — bash's mechanism is all in the argv.
    const shim = (shimEnv && shimEnv(seat)) || null;
    // Read off the shim, never its env half: bash's shim legitimately adds no env,
    // and a `!!shim.env` test would refuse every exec on a correctly shimmed bash.
    const shimmed = !!shim;

    let proc;
    try {
      proc = spawn(shellFor(), (shim && shim.args) || DEFAULT_ARGS, {
        name: 'xterm-256color',
        cols,
        rows,
        cwd,
        env: { ...(env || process.env), ...((shim && shim.env) || {}), TERM: 'xterm-256color' },
      });
    } catch (e) {
      logger.warn('wterm', `spawn failed: ${e.message}`);
      return { error: e.message };
    }

    // Scrollback and live bytes take different IPC paths, so a seq-less renderer
    // double-prints the overlap or drops the tail.
    const rec = { proc, scrollback: '', cols, rows, windowId, seat: seat || null, seq: 0, shimmed, pending: null };
    // Per shell, not per window: one parser shared across seats would attribute one
    // seat's output to another's command. Marks are still forwarded to the renderer —
    // stripping them would fork the same bytes into two divergent copies.
    rec.marks = (onCommand && makeMarkParser && seat)
      ? makeMarkParser({
        onCommand: (c) => {
          // Decided before settle(), which clears the record it reads.
          const mine = !!rec.pending && !foreignRecord(rec.pending, c);
          settle(rec, { status: 'ok', record: c });
          // Ours must not also reach the firehose: both feed one selection queue.
          if (!mine) { try { onCommand(seat, c); } catch {} }
        },
        onAbandon: (c) => { settle(rec, { status: 'abandoned', record: c }); },
        onPrompt: (info) => { if (rec.execPromptAck) rec.execPromptAck(info); },
      })
      : null;
    ptys.set(key, rec);

    proc.onData((data) => {
      // Before the parser is fed, so a shell emitting no marks still retires the
      // silence deadline. Bytes retire it and nothing else — they cannot say whether
      // the interrupt has been processed.
      if (rec.execArm) rec.execArm();
      if (rec.marks) { try { rec.marks.feed(data); } catch {} }
      rec.scrollback += data;
      rec.seq += 1;
      if (rec.scrollback.length > MAX) rec.scrollback = rec.scrollback.slice(-MAX);
      // The seat rides along, or a background seat's output lands in whichever
      // terminal is mounted and two scrollbacks interleave unrecoverably.
      send(windowId, 'wterm:data', data, rec.seat, rec.seq);
      // Fed from here, not from a copy of the scrollback, so the two views cannot
      // diverge: one shell is the safety property of the peer terminal. Isolated
      // because a wire that throws must not break the local tab.
      if (onOutput && rec.seat) { try { onOutput(rec.seat, data); } catch {} }
    });

    proc.onExit(({ exitCode }) => {
      // Before the identity guard: a dead shell took its pending command with it.
      settle(rec, { status: 'shell-exit', exitCode });
      // Identity, not key. A child trapping SIGHUP outlives the kill() that closed
      // its window; reopening that workspace spawns a successor at this key, and a
      // delete-by-key would unmap the LIVE one.
      if (ptys.get(key) !== rec) return;
      // Drop the record before announcing, or the respawn is handed the corpse.
      ptys.delete(key);
      send(windowId, 'wterm:data', `\r\n\x1b[2m[shell exited: ${exitCode}]\x1b[0m\r\n`, rec.seat);
      if (onShellEnd && rec.seat) { try { onShellEnd(rec.seat, exitCode); } catch {} }
    });

    return rec;
  }

  // Every path that can end a command routes here — D mark, abandon, shell exit, seat
  // and window kills — or an agent waits forever on a command whose ending nobody
  // announced. Idempotent by clearing `pending` first: two paths can legitimately
  // fire for one command. The deadline timer is identity-checked rather than cleared;
  // drawer-pty.test.js pins that this module requires nothing, so reaching for a
  // global clearTimeout would break that pin.
  function settle(rec, outcome) {
    const p = rec.pending;
    if (!p) return false;
    rec.pending = null;
    // The arm is not cleared either: identity at the point of use also covers an
    // already-dispatched fallback closure, which would otherwise type a settled
    // command onto a later one's line.
    if (!onExecResult) return true;
    // A D mark for a command that is not ours: the operator's Enter on `vim` marks C
    // a PTY round trip later, so an exec inside that window sees isBusy() false and
    // writes into vim's stdin. No pre-check can close it — we settle anyway, and only
    // refuse to claim the result.
    const mismatch = foreignRecord(p, outcome && outcome.record);
    const res = { ...outcome, command: p.command, late: !!p.timedOut };
    if (mismatch) res.mismatch = true;
    try { onExecResult(rec.seat, res); } catch {}
    return true;
  }

  function foreignRecord(p, record) {
    const reported = String((record && record.command) || '').trim();
    return !!reported && reported !== p.command;
  }

  function endShell(rec) {
    // The only place that can tell a watching peer: both callers delete the record
    // first, so the PTY's own onExit hits the identity guard and returns before its
    // onShellEnd. That guard is also why this cannot double-announce.
    if (onShellEnd && rec.seat) { try { onShellEnd(rec.seat, 'closed'); } catch {} }
    // Read the pid first — the escalation runs 5s later, when nothing resolves proc.
    const pid = rec.proc.pid;
    try { rec.proc.kill(); } catch {}
    // pty.kill() is SIGHUP, which a child trapping or ignoring HUP survives. `unref`
    // so a quit is never held open for five seconds.
    const t = later(() => { try { killProcess(pid, 'SIGKILL'); } catch {} }, 5000);
    if (t && typeof t.unref === 'function') t.unref();
  }

  // A PTY dimension of 0 makes the child's ioctl meaningless; the renderer
  // legitimately reports 0 while measuring a pane mid-transition.
  function clampDim(n, fallback) {
    const v = Math.floor(Number(n));
    return Number.isFinite(v) && v > 0 ? v : fallback;
  }

  return {
    spawn(windowId, seat, opts) {
      const had = ptys.has(keyFor(windowId, seat));
      const rec = spawnFor(windowId, seat, opts);
      if (!rec) return { ok: false, error: 'drawer terminals are unavailable on this host' };
      if (rec.error) return { ok: false, error: rec.error };
      return { ok: true, fresh: !had, scrollback: rec.scrollback, cols: rec.cols, rows: rec.rows, seat: rec.seat, seq: rec.seq };
    },

    // Raw keystrokes, arbitrated by nothing: exec()'s machinery serialises commands,
    // and a keystroke has no settled beginning or end. Two typists share one shell and
    // their bytes can interleave mid-line — the accepted price of the shared-PTY
    // ruling. Do not give the peer its own shell; that trades a visible annoyance for
    // an invisible exposure.
    write(windowId, seat, data) {
      const rec = ptys.get(keyFor(windowId, seat));
      if (!rec || typeof data !== 'string') return false;
      try { rec.proc.write(data); return true; } catch { return false; }
    },

    // Never spawns, unlike write(): a shell the operator did not ask for would appear
    // with a command already running in it. Every refusal is checked HERE, not by a
    // caller reading a status first — a foreground program can start in the gap
    // between a check and the write, and the command lands in its stdin.
    exec(windowId, seat, command) {
      if (!seat) return { ok: false, code: 'no-seat' };
      const vet = vetCommand ? vetCommand(command) : { ok: true, command };
      if (!vet.ok) return { ok: false, code: 'bad-command', error: vet.error };
      const rec = ptys.get(keyFor(windowId, seat));
      if (!rec) return { ok: false, code: 'no-shell' };
      // No marks ⇒ no D ⇒ nothing tells the agent this finished, but it still runs.
      if (!rec.shimmed || !rec.marks) return { ok: false, code: 'no-marks' };
      // A timed-out command over an idle terminal never got an ending and never will;
      // without this every later exec answers `pending` and the seat is wedged.
      if (rec.pending && rec.pending.timedOut && !rec.marks.isBusy()) {
        settle(rec, { status: 'lost' });
      }
      // Distinct from `busy`: between the write and the C mark the parser is not
      // capturing yet, so a second exec passes a busy check and types over the first.
      if (rec.pending) return { ok: false, code: 'pending', running: rec.pending.command };
      if (rec.marks.isBusy()) return { ok: false, code: 'busy' };

      const p = { command: vet.command, timedOut: false };
      rec.pending = p;
      try {
        // Abandon the line first: `isBusy()` false says nothing about the line editor,
        // which may hold a half-typed line the C mark would then report as ours.
        // TWO WRITES, and they must not be merged: ^C is a signal, not an in-band byte,
        // so a merged write asks the line discipline to split one buffer across an
        // interrupt.
        //
        // Writing the command while the shell owes us a prompt costs its leading byte,
        // and the truncated remainder still RUNS — `echo a; echo b` arrives as
        // `cho a; echo b`. Separating the writes in TIME does not fix that: measured at
        // 32 concurrent shells with a fixed 3s sleep between them and no handshake at
        // all, 2 of 192 still lost the byte, so there is no gap wide enough to buy
        // safety. What predicts the loss is the missing prompt, not the interval — over
        // 256 execs, every one of the 254 that saw an A mark after the ^C arrived
        // intact and both that did not were truncated. Hence the release below waits
        // for that mark rather than for a duration.
        rec.proc.write(ABANDON_LINE);
      } catch (e) {
        rec.pending = null;
        return { ok: false, code: 'write-failed', error: String((e && e.message) || e) };
      }
      let armed = false;
      const typeCommand = () => {
        if (armed) return;
        armed = true;
        if (rec.execArm === arm) rec.execArm = null;
        if (rec.execPromptAck === promptAck) rec.execPromptAck = null;
        // The command belongs to the exec that started it; `pending` may hold a later
        // one, and typing then puts our bytes on a line its waiter will claim.
        if (rec.pending !== p) return;
        try {
          rec.proc.write(vet.command + ENTER);
        } catch (e) {
          // exec() already returned ok, so an error return here would reach nobody.
          settle(rec, { status: 'write-failed', reason: String((e && e.message) || e) });
        }
      };
      // A flag, not a cancelled handle: the timer seam is injected, so a caller's
      // fake may return something clearTimeout ignores.
      let spoke = false;
      // Bytes do not release the command. ^C is consumed by the line discipline as a
      // signal, delivered asynchronously with respect to the byte stream, so a shell
      // can emit a quiet, line-editor-ready prompt while the interrupt is still
      // pending — a quiet-window heuristic cannot work at any value.
      const arm = () => { spoke = true; };
      // A plain redraw carries no interrupt status and must not release the command,
      // or we type onto a line the interrupt is about to kill. Counting redraws is
      // wrong at any N: the number is theme-dependent and unbounded.
      const promptAck = (info) => { if (info && info.interrupted) typeCommand(); };
      rec.execPromptAck = promptAck;
      later(() => { if (!spoke) typeCommand(); }, ABANDON_ACK_MS);
      // The shell spoke but never acked: it drew a prompt carrying no interrupt status,
      // which is the exact state the ABANDON_MAX_MS write below then types into and
      // loses a byte to. Repeat the abandon instead of typing into it — a shell at a
      // prompt answers a second ^C with a fresh prompt cycle (measured: the elicited A
      // mark arrives ~1ms later), and that mark releases the command through promptAck
      // like any other. A shell that ignores the repeat too still falls through to the
      // cap below, so this narrows the blind write rather than removing it.
      //
      // ONE repeat, not a retry loop: the escape hatch is ABANDON_MAX_MS, and a loop
      // would keep signalling a foreground program that is legitimately slow to die.
      // A silent shell must NOT be nudged — it is the ABANDON_ACK_MS case above, which
      // has already typed, so a second ^C would interrupt that command. `armed` alone
      // covers it whenever these two timers fire in their nominal order; `spoke` is
      // read directly so the guard holds without depending on that order.
      let nudged = false;
      later(() => {
        if (armed || nudged || !spoke) return;
        nudged = true;
        // Same identity check as typeCommand: `pending` may hold a later exec by now,
        // and signalling then kills a command this one does not own.
        if (rec.pending !== p) return;
        try { rec.proc.write(ABANDON_LINE); } catch {}
      }, ABANDON_NUDGE_MS);
      // Types eventually whatever the shell does, including for a background job
      // writing to the tty (isBusy() false, so the exec is accepted); without the cap
      // those hang to EXEC_TIMEOUT, reporting a timeout for a command that never ran.
      later(typeCommand, ABANDON_MAX_MS);
      rec.execArm = arm;

      const timer = later(() => {
        if (rec.pending !== p || p.timedOut) return;
        p.timedOut = true;
        // The pending record deliberately survives: the command was not cancelled, so
        // the eventual D mark still delivers, flagged `late`.
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

    // A loop, not a lookup: the keying went per-seat, and one lookup would strand
    // every seat's shell but the first.
    kill(windowId) {
      let killed = false;
      for (const [k, rec] of [...ptys]) {
        if (rec.windowId !== windowId) continue;
        ptys.delete(k);
        // Before the kill, while the seat is knowable: no D mark is coming.
        settle(rec, { status: 'shell-gone', reason: 'the workspace window was closed' });
        endShell(rec);
        killed = true;
      }
      return killed;
    },

    // Nothing else reaps this — window close is the wrong event, and without it a
    // workspace accumulates a shell per unreachable seat.
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
        // Deliberately not settled: dispose() is app quit, so a delivery would write
        // into a queue nobody will drain.
        rec.pending = null;
        try { rec.proc.kill(); } catch {}
      }
    },

    _count: () => ptys.size,

    // Never for a caller to pre-check and then act on: that race is the reason exec
    // takes the refusal decisions itself.
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
