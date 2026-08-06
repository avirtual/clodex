'use strict';
// drawer-avail.js — which drawer tabs a given seat can be served by, and what a
// seat is allowed to type into one.
//
// A pure leaf rather than a line inside term-tab.js because term-tab is
// DOM-bound and therefore untested (the R1 rule), while this predicate is the
// whole content of two defects and is exactly the part worth pinning.
//
// It sits at the repo root rather than under renderer/lib/ because BOTH
// processes read it: the renderer decides whether to draw the tab, and the main
// process refuses `[agent:term exec]` for a seat that has none. A second copy in
// main would answer the same question differently the first time either changed.

// The terminal tenant, per seat. Both exclusions are defects that shipped, not
// preferences:
//
//   bash   — the session IS a shell. A second one in the drawer shares nothing
//            with it (different process, different cwd, different history) and
//            the tab reads as if it were that session's terminal.
//   remote — a peer session lives on ANOTHER BOX, so a LOCAL shell is not its
//            terminal in any sense. Worse than merely misleading: the renderer
//            keys a peer as `name@id` (peers-ui.js), `@` fails the seat grammar
//            in ipc-handlers' `seatOf`, and a rejected seat becomes null — which
//            is the key of the SEATLESS workspace shell. So every peer row was
//            handed the one workspace-wide terminal, sharing it with each other
//            and with the no-session drawer.
//
// A null type is the seatless drawer (no session selected), which is that
// workspace-wide shell's legitimate home — so it stays available.
function termAvailableFor(type) {
  return type !== 'bash' && type !== 'remote';
}

// A command line is generous at 2KB and absurd beyond it. The cap is on BYTES,
// not characters: the PTY is a byte stream and a multi-byte payload that passes
// a length check can still be four times this on the wire.
const TERM_EXEC_MAX = 2048;

// Built from a STRING, never a regex literal with the bytes in it. A literal
// control character in source is invisible and does not reliably survive
// reformatting, transcription or an editor that sanitizes on save — the class
// narrows silently to whatever is left, `node --check` sees nothing wrong, and
// the reviewer reads a line that looks correct. This form is nine printable
// characters that cannot degrade. (plugins/plugin-api.md §4 documents the same
// hazard for the plugin-side oneLine.)
const CTRL_RE = new RegExp('[\\u0000-\\u001F\\u007F]');

// What each control byte would actually DO if it reached the shell, which is why
// this rejects rather than strips: a stripped `rm -rf /\nyes` becomes a
// DIFFERENT command that still runs, and the agent is never told its command was
// rewritten. Refusing hands the decision back to the one that can fix it.
const CTRL_WHY = new Map([
  [0x0a, 'a newline (LF) \u2014 everything before it would execute immediately'],
  [0x0d, 'a carriage return (CR) \u2014 everything before it would execute immediately'],
  [0x1b, 'an escape (ESC) \u2014 some terminals answer escape sequences by writing to their own stdin, which injects bytes you did not send'],
  [0x09, 'a tab \u2014 the shell would treat it as a completion request, not whitespace'],
  [0x00, 'a NUL byte'],
]);

// Vet the payload of `[agent:term exec]`. Pure: no shell, no filesystem, no
// judgement about what the command DOES — quoting and safety of the command
// itself belong to the operator who can see the terminal, and pretending to
// validate shell semantics here would be security theatre over a login shell
// the agent could reach through its own tools anyway. What this owns is the
// framing: exactly one line, of bounded length, containing nothing that turns
// one write into two.
function vetTermCommand(raw) {
  const s = typeof raw === 'string' ? raw : '';
  // Trimmed only at the ENDS. Interior whitespace is the command's own.
  const cmd = s.trim();
  if (!cmd) return { ok: false, error: 'no command — [agent:term exec] needs the command on the same line or the lines below it' };
  const bytes = Buffer.byteLength(cmd, 'utf8');
  if (bytes > TERM_EXEC_MAX) {
    return { ok: false, error: `command is ${bytes} bytes, over the ${TERM_EXEC_MAX}-byte limit — put a long command in a script and run that` };
  }
  const m = cmd.match(CTRL_RE);
  if (m) {
    const code = m[0].charCodeAt(0);
    // Keyed by CODE POINT, not by the character itself: an object literal whose
    // keys were the raw bytes would carry five invisible characters in this
    // source file, which is the same hazard the pattern above is built from a
    // string to avoid — and a key that failed to survive an edit would silently
    // fall through to the generic branch rather than break anything visibly.
    const why = CTRL_WHY.get(code) || `a control character (U+${code.toString(16).toUpperCase().padStart(4, '0')})`;
    // The INDEX is reported because the byte is invisible in the agent's own
    // output — "there is a newline somewhere" is not actionable, and the agent
    // usually did not know it emitted one.
    return { ok: false, error: `command contains ${why} at position ${m.index} — rejected, not stripped: silently removing it would run a command you did not write. Send one line.` };
  }
  return { ok: true, command: cmd };
}

module.exports = { termAvailableFor, vetTermCommand, TERM_EXEC_MAX };
