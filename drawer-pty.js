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
function createDrawerPtys({ spawn, send, shell, cwdFor, scrollbackMax, env, log, setTimeout: setTimeoutFn, killPid, shimEnv, onCommand, makeMarkParser, onExecResult, vetCommand, execTimeoutMs, onOutput, onShellEnd }) {
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
  // From a code point rather than a literal byte in this source: a raw control
  // character is invisible, does not reliably survive reformatting or an editor
  // that sanitizes on save, and its loss would be silent — the write would
  // simply stop clearing the line. Same reason drawer-avail builds its detector
  // pattern from a string.
  //
  // Abandon whatever is on the line before typing. NOT a line-editor kill:
  // ^U/^K are emacs-keymap BINDINGS, and under `bindkey -v` zsh binds ^K to
  // self-insert, so 0x0b was typed as a literal `^K` in front of the command and
  // the shell ran `^Kls`. Measured, twice independently, against real zsh and
  // bash in both keymaps. ^U alone looks like it survives vi mode but only when
  // the cursor sits at end of line — viins `vi-kill-line` kills BACKWARD, so a
  // draft the operator left with the cursor mid-line keeps its tail. 0x03 is a
  // signal the tty layer handles, not a binding, so it is keymap-independent and
  // cursor-independent. The prompt it redraws is safe here: exec() only writes
  // when `isBusy()` is false, and term-marks treats an A mark while not
  // capturing, and a D with no preceding C, as nothing to report.
  const ABANDON_LINE = String.fromCharCode(0x03);
  const ENTER = String.fromCharCode(0x0d);
  // How long to wait for a shell that answers the ^C with NOTHING AT ALL before
  // typing anyway — ^C on an empty line under a prompt that does not redraw —
  // where waiting forever would be a command that never runs and an agent that
  // never hears back. It is armed only while the shell has stayed SILENT: the
  // first byte makes it inert for good, and the cap below governs from there.
  const ABANDON_ACK_MS = 250;
  // The ceiling on the whole abandon handshake, and — for a shell that speaks
  // without ever marking an interrupt — the ONLY thing that types. Bytes do not
  // release the command at all (see `arm`), so this is where a talking shell
  // ends up rather than a last resort it rarely reaches.
  //
  // It cannot be read as evidence the interrupt landed, and it does not claim to
  // be: it is the bound on the opposite failure, a command that never runs and
  // an agent that never hears back. That is why it is a full second rather than
  // a tuned window — a value chosen to be LATER than any plausible flush, not
  // one chosen to track it.
  const ABANDON_MAX_MS = 1000;
  // THE PRIMARY SIGNAL: an OSC 133 A reporting exit 130, seen after the ^C went
  // out. A prompt mark is drawn by the shell's own precmd, so unlike "some bytes
  // arrived" it is evidence about the SHELL's state — the line editor is ready —
  // rather than about the wire. That is what the three clocks above can only
  // estimate.
  //
  // WHAT THE STATUS ACTUALLY PROVES, stated exactly: the last command to finish
  // exited 128+SIGINT. That is strictly stronger than "a prompt was drawn" — a
  // plain redraw carries no such status — and it is why this is worth having.
  //
  // IT IS NOT PROOF THAT THE INTERRUPT IS OURS, and must not be read as one.
  // `$?` is LATCHED: it survives every prompt cycle until a command actually
  // runs, so after any interrupt the shim re-emits D;130 then A on each empty
  // Enter, indefinitely. Measured on real zsh and bash — ^C, then three bare
  // Enters, all four reporting 130; only running `true` clears it to 0. Two
  // residual windows follow, and NEITHER is closed here:
  //
  //   (a) STALE LATCH — an earlier interrupt left `$?` at 130, and any prompt
  //       cycle inside our race window (the operator pressing Enter is enough)
  //       re-reports it as if it were the reply to our ^C.
  //   (b) IN-FLIGHT — a D;130 A pair generated BEFORE our write but delivered to
  //       feed() after it, which is indistinguishable on arrival.
  //
  // THE CLOCKS ARE THE ONLY THING STANDING BEHIND BOTH. Since bytes no longer
  // release the command, deleting them leaves nothing but a signal that can
  // lie — an unrecoverable trade, not a cleanup.
  //
  // It is not a new requirement on the shell: exec() already refuses unless
  // `rec.shimmed && rec.marks`. THE CLOCKS ARE STILL THE BACKSTOP, and the
  // shells that need them are the operator's, not a fixture's: a profile that
  // aborts before the hooks install (`set -u` against an unset expansion), and a
  // profile that clobbers `precmd_functions` / `PROMPT_COMMAND` after ours is
  // prepended. Either leaves a shell that was born `shimmed` and emits no A;
  // mark-only, every exec on one of those hangs to EXEC_TIMEOUT. Narrowing the
  // mark to a 130 widens that set — a shell whose ^C reports no status now falls
  // back too — which costs latency and never correctness.
  //
  // `shopt -u promptvars` is NOT one of them, though it looks like it should be:
  // it suppresses PS0 expansion, and PS0 carries the C mark — A comes from
  // PROMPT_COMMAND, which promptvars does not touch. It costs the command TEXT,
  // not the readiness signal.

  function shellFor() {
    return shell || (env && env.SHELL) || process.env.SHELL || '/bin/zsh';
  }

  // A login shell is the default and is deliberate: the operator's aliases and
  // PATH are the point of a workbench terminal, and an aws-cli or nvm-shimmed
  // binary missing from a non-login PATH is exactly the debugging case this tab
  // exists for.
  //
  // A shim may REPLACE it, which is why the argv is not simply fixed here. bash
  // cannot be shimmed and stay a login shell — the two mechanisms are mutually
  // exclusive (a login bash ignores `--rcfile`) — so its shim hands back a
  // non-login argv and reconstructs the login startup inside the file it
  // generates. An unshimmed shell, and zsh's shim, both keep `-l`.
  const DEFAULT_ARGS = ['-l'];

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

    // The OSC 133 shim, or null on a host that could not build one (an
    // unsupported shell, a bash too old for PS0, an unwritable dir). Null must
    // stay ordinary: the shell spawns unshimmed, emits no marks, and behaves
    // exactly as it did before this feature existed — reporting is the thing
    // that degrades, never the terminal.
    //
    // `{ env, args }`, not an env map. bash's mechanism is entirely in the
    // argv, so a seam carrying only env would silently produce a shell that
    // reads none of what was generated for it.
    const shim = (shimEnv && shimEnv(seat)) || null;
    // Whether THIS shell was born shimmed, remembered because the pref can be
    // toggled afterwards and the shell keeps whatever startup it got. Anything
    // asking "will a command in here report back?" must consult the shell, not
    // the current setting — a shell spawned before the pref was turned on emits
    // no marks however the checkbox reads now.
    //
    // Read off the SHIM, never off its env half: bash's shim legitimately adds
    // no environment at all, and a `!!shim.env` test would call a correctly
    // shimmed bash unshimmed and refuse every exec on it with `no-marks`.
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
        // The prompt is back. The flag is forwarded rather than dropped because
        // exec() needs what it reports: the last command to finish exited
        // 128+SIGINT. That filters out a bare redraw, which carries no such
        // status — it does NOT say whose interrupt it was. See the constants
        // block for the two residuals that leaves open.
        onPrompt: (info) => { if (rec.execPromptAck) rec.execPromptAck(info); },
      })
      : null;
    ptys.set(key, rec);

    proc.onData((data) => {
      // The shell has spoken. That retires the silence deadline and NOTHING
      // else: bytes cannot say whether the interrupt has been processed, so they
      // never release a pending command. Runs BEFORE the mark parser is fed only
      // so a shell that emits no marks still leaves the deadline behind.
      if (rec.execArm) rec.execArm();
      if (rec.marks) { try { rec.marks.feed(data); } catch {} }
      rec.scrollback += data;
      rec.seq += 1;
      if (rec.scrollback.length > MAX) rec.scrollback = rec.scrollback.slice(-MAX);
      // The SEAT rides along so the renderer can drop bytes for a shell that is
      // no longer on screen. Without it, output from a background seat's shell
      // would be written into whichever terminal happens to be mounted — the
      // scrollbacks would interleave and neither would be recoverable.
      send(windowId, 'wterm:data', data, rec.seat, rec.seq);
      // A second consumer of the SAME bytes, for a peer watching this seat's
      // terminal over the wire. Fed from here rather than from a copy of the
      // scrollback so the two views cannot diverge: they are one shell, which is
      // the whole safety property of the peer terminal (a separate hidden PTY
      // for a remote party IS the silent remote shell).
      //
      // "One shell" is a claim about the BYTES and nothing more — it does not
      // say a local tab is showing them. Whether one can be is decided
      // upstream, by remote-wiring's `wtermOpen` refusing a workspace with no
      // window; this line would happily feed a peer a shell nobody here can see.
      // Isolated because a wire that throws must not break the local tab.
      if (onOutput && rec.seat) { try { onOutput(rec.seat, data); } catch {} }
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
      // A peer watching this seat is told the shell ended, not left staring at a
      // stream that has simply gone quiet.
      if (onShellEnd && rec.seat) { try { onShellEnd(rec.seat, exitCode); } catch {} }
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
    // Nothing clears the pending exec's ARM here, deliberately, and the same
    // reasoning the deadline timer uses above applies: it is identity-checked at
    // the point of use (`rec.pending !== p`), which covers what a clear here
    // cannot — the 250ms fallback closure captured by an ALREADY-DISPATCHED
    // timer, which survives any amount of clearing and would otherwise type a
    // settled command onto a later one's line. Clearing as well was measured
    // redundant: with the identity check in place, removing it kills no test.
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
    // A peer watching this seat is told, and this is the only place that can
    // tell them: both callers delete the record before getting here, so when
    // the PTY's own onExit fires it hits the identity guard and returns before
    // its onShellEnd — the peer would otherwise be left with a stream that
    // simply stops. Same guard is why this cannot double-announce.
    //
    // 'closed' rather than an exit code because there was no exit: the operator
    // closed the window or the seat, which is a different thing from a shell
    // that ended on its own, and the consumer renders whatever it is given.
    if (onShellEnd && rec.seat) { try { onShellEnd(rec.seat, 'closed'); } catch {} }
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

    // RAW KEYSTROKES, arbitrated by nothing. The busy/pending machinery below
    // belongs to exec() alone: it serialises COMMANDS, which have a settled
    // beginning and end, and it cannot cover this path because a keystroke has
    // neither — half a line is a legitimate thing to send.
    //
    // Since t219 there can be two typists on one shell: the local operator's
    // tab and a peer's. Their bytes interleave, and a peer's `ls` can land
    // inside a half-typed local line. That cost is ACCEPTED, not overlooked —
    // it is the price of the shared-PTY ruling, which exists so a remote shell
    // is visible in a tab the operator already has rather than hidden in a
    // second PTY nobody is watching. Do not "fix" it by giving the peer its own
    // shell; that trades a visible annoyance for an invisible exposure.
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
        // Abandon the line FIRST. `isBusy()` false says no command is RUNNING;
        // it says nothing about the line editor, which may hold a half-typed
        // line the operator walked away from — appending to that would run their
        // fragment plus our command as one line, and the C mark would report the
        // COMBINED line as if it were ours.
        //
        // TWO WRITES, and they must not be merged. ^C is a SIGNAL, not an
        // in-band byte: bash discards its pending input when SIGINT lands, so
        // anything sharing this write can be swallowed with it — measured at 3
        // failures in 72 under load, and what came out was `cho: command not
        // found`, i.e. a TRUNCATED command that still runs. That is worse than
        // the keymap bug this replaced, which at least failed loudly. The shell
        // emitting anything at all is the acknowledgement that its flush is
        // done; a timer would be a guess about a machine under unknown load.
        rec.proc.write(ABANDON_LINE);
      } catch (e) {
        rec.pending = null;
        return { ok: false, code: 'write-failed', error: String((e && e.message) || e) };
      }
      // The command is typed from the shell's next output, or from a deadline if
      // the shell says nothing (a ^C on an already-empty line with no prompt
      // redraw). `settled` makes the two paths exclusive — whichever runs first
      // owns the write, so a shell that answers just as the deadline fires does
      // not get the command twice.
      let armed = false;
      const typeCommand = () => {
        if (armed) return;
        armed = true;
        // Hygiene: the arm no longer schedules anything, so leaving it wired
        // would cost a flag write per byte rather than a timer, but a finished
        // exec should not stay attached to a shell that outlives it.
        if (rec.execArm === arm) rec.execArm = null;
        // Hygiene, not a correctness guard — `armed` above already makes a
        // stale ack a no-op, so do not read this as what prevents a double
        // type. It drops the finished exec's closure instead of leaving it
        // wired to a shell that redraws its prompt for the rest of its life.
        if (rec.execPromptAck === promptAck) rec.execPromptAck = null;
        // The command belongs to the exec that STARTED it. By now `pending` may
        // hold a later one (a window kill settled ours and a new command came
        // in), and typing then would put our bytes on a line the current waiter
        // will claim as its own result.
        if (rec.pending !== p) return;
        try {
          rec.proc.write(vet.command + ENTER);
        } catch (e) {
          // The failure has to reach the waiter: exec() has already returned ok
          // by this point, so returning an error here would reach nobody.
          settle(rec, { status: 'write-failed', reason: String((e && e.message) || e) });
        }
      };
      // Two clocks, and they are not interchangeable. The SILENCE deadline
      // covers a shell that never answers at all; the CAP covers one that does.
      // `spoke` hands ownership from the first to the second — a shell that has
      // said anything is no longer silent, so it waits out the cap instead.
      //
      // A FLAG rather than a cancelled handle because the deadline must stay
      // inert even where the handle cannot be cleared: the timer seam is
      // injected, so a caller's fake may return something clearTimeout ignores.
      // A silence deadline that still fired after the shell had spoken would
      // type on a schedule that no longer describes it.
      let spoke = false;
      // BYTES DO NOT RELEASE THE COMMAND. They only mark the shell as having
      // spoken, which retires the silence deadline above and hands the schedule
      // to the cap.
      //
      // This is the whole of the second fix, and it is a deletion rather than a
      // new mechanism: what used to be here was a 60ms quiet window that typed
      // once the shell stopped talking. It could not work, at any value. ^C is
      // consumed by the tty line discipline as a SIGNAL to the foreground
      // process group, delivered asynchronously with respect to the byte stream,
      // so a shell can emit a complete, quiet, line-editor-ready prompt while
      // the interrupt is still pending — measured in the captured failure, where
      // the first paint ends with bracketed paste ON (zle entered) and the
      // interrupt's own D;130 arrives two lines LATER. "Quiet for 60ms" is a
      // fact about the wire, and the question is about a signal.
      //
      // That window is what typed in the captured failure: no prompt mark had
      // been seen at all when the command went out (the first A in the capture
      // postdates our echoed first byte), the 250ms deadline was already inert,
      // and the cap was still 900ms away. Idle, the gap from first byte to
      // D;130 measures 0-1ms and never reaches 60; under full-suite load it
      // crosses, which is the ~1-in-132 rate this ticket chased.
      //
      // Nothing types EARLIER than before as a result: the release that was
      // removed was the earliest of the three, and the two that remain — the
      // interrupt-marked prompt and the cap — are unchanged. A shell that both
      // speaks and never marks an interrupt now waits out the cap instead of the
      // window, which is later and correct rather than sooner and hopeful.
      const arm = () => { spoke = true; };
      // The fast path, and it turns on WHICH prompt mark this is: one reporting
      // that the last command exited 128+SIGINT. A plain redraw carries no such
      // status, so it no longer releases the command — which is the difference
      // between this and typing onto a line the interrupt is about to kill.
      //
      // It is a FILTER, not a proof of ownership. `$?` is latched, so a stale
      // 130 from an earlier interrupt re-reports on any later prompt cycle, and
      // a pair generated before our write can still arrive after it. Both are
      // left open deliberately: closing them means forfeiting the fast path
      // whenever a 130 is ambiguous — paying the silence deadline on every exec
      // that follows an interrupt — to buy a window the clocks already cover.
      // See the constants above for the full statement.
      //
      // Counting is still wrong, for its own reason: the number of redraws is
      // theme-dependent and unbounded, so no N is safe.
      //
      // Whichever fires first — a qualifying mark or a clock — wins, and
      // typeCommand is idempotent, so the losers are no-ops. A shell whose ^C
      // never reports a status simply never takes this path and falls back to
      // the clocks: later, not wrong.
      const promptAck = (info) => { if (info && info.interrupted) typeCommand(); };
      rec.execPromptAck = promptAck;
      later(() => { if (!spoke) typeCommand(); }, ABANDON_ACK_MS);
      // The command is typed EVENTUALLY, whatever the shell does, and this now
      // carries every shell that speaks without ever marking an interrupt —
      // including a BACKGROUND job writing to the tty, which leaves isBusy()
      // false so exec() is accepted and the ^C delivered. Without this cap those
      // would hang to EXEC_TIMEOUT, reporting a timeout for a command that never
      // ran. Unconditional because every other path here is conditional on the
      // shell behaving; typeCommand is idempotent, so this is a no-op whenever
      // one of them already won.
      later(typeCommand, ABANDON_MAX_MS);
      rec.execArm = arm;

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
