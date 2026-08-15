'use strict';
// term-marks.js — OSC 133 semantic prompt marks: the parser, and the prose that
// describes a finished command to the agent.
//
// WHY MARKS AT ALL. A terminal is a screen, not a stream of results: there is no
// byte that says "this command's output starts here", no exit code anywhere in
// the bytes, and — because the operator may edit a line before running it — no
// way to know from the outside what actually ran. Inferring any of that from the
// output (find the prompt, diff the screen) is prompt-shape guesswork that
// breaks on every custom PS1 and cannot recover the exit code at all.
//
// OSC 133 is the existing answer (iTerm2, VSCode, WezTerm all speak it): the
// SHELL emits invisible marks at the boundaries it alone knows. That is what
// makes this parser small and honest — it reads facts rather than deducing them.
//
// The subset this file understands, which is what term-shim.js emits:
//   ESC ] 133 ; A            BEL   prompt about to be drawn
//   ESC ] 133 ; C ; <b64>    BEL   command STARTED; payload is what actually ran
//   ESC ] 133 ; D ; <exit>   BEL   command finished, with its status
// The command rides base64 on the C mark because a command line legitimately
// contains `;` and BEL-adjacent bytes, and a raw one would end its own mark.
// A is parsed but carries nothing; it exists so the abandon case below can be
// told apart from a command that is simply still running.
//
// Electron-free and stream-shaped by construction: it is fed PTY chunks and
// emits records. That is also what makes it testable without a shell.

// Bounded so a lone ESC arriving at the end of a chunk cannot grow `carry`
// without limit — the longest legal mark is C with a base64 command, which the
// shim itself caps.
const MAX_CARRY = 8 * 1024;

// A mark, complete only when BEL-terminated. `[^\x07]*` deliberately cannot
// cross a BEL, so a mark can never swallow the output that follows it.
const MARK_RE = /\x1b\]133;([^\x07]*)\x07/g;
// A trailing PARTIAL mark: the chunk ended mid-sequence. Anything matching this
// is held for the next feed rather than being emitted as output — without it,
// a mark split across two PTY reads would print its own bytes into the captured
// output and then fail to frame anything.
const PARTIAL_RE = /\x1b(?:\](?:1(?:3(?:3(?:;[^\x07]*)?)?)?)?)?$/;

function createMarkParser({ onCommand, onAbandon, onPrompt, maxOutput } = {}) {
  const MAX_OUT = maxOutput || 64 * 1024;
  let carry = '';
  let capturing = false;
  let command = '';
  let out = '';

  function emit(exitCode) {
    const rec = { command, exitCode, output: out };
    capturing = false;
    command = '';
    out = '';
    if (onCommand) onCommand(rec);
  }

  function text(chunk) {
    if (!capturing || !chunk) return;
    out += chunk;
    // Keep the TAIL, not the head: a build's last lines are where the error is,
    // and the head is the part the operator already watched scroll past.
    if (out.length > MAX_OUT) out = out.slice(-MAX_OUT);
  }

  return {
    feed(data) {
      if (typeof data !== 'string' || !data) return;
      const s = carry + data;
      carry = '';
      let last = 0;
      MARK_RE.lastIndex = 0;
      let m;
      while ((m = MARK_RE.exec(s)) !== null) {
        text(s.slice(last, m.index));
        last = MARK_RE.lastIndex;
        const body = m[1];
        if (body === 'A') {
          // A fresh prompt while a command is open means it never finished and
          // never will — Ctrl-C at the prompt, or a shell that reset. The record
          // is still DROPPED (an abandoned line has no exit code, and holding it
          // open would attribute the NEXT command's output to it), but dropping
          // it SILENTLY is a hang for anything waiting on this command: nothing
          // else in the stream ever mentions it again. So the drop is announced
          // and the announcement carries no exitCode — there is none, and
          // inventing 130 would claim a SIGINT that may not be what happened.
          if (capturing) {
            const rec = { command, output: out };
            capturing = false;
            command = '';
            out = '';
            if (onAbandon) onAbandon(rec);
          }
          // Announced on EVERY A, including the ones above that report nothing:
          // this says "a prompt was drawn", which is a fact about the shell and
          // not about any command. drawer-pty's exec() uses it as the positive
          // acknowledgement that its ^C was PROCESSED — the one thing a
          // byte-counting timer cannot establish, since bytes already in flight
          // when the signal was written look identical to a reply to it.
          // Fired after the abandon so a consumer settling a record sees it
          // settled before it is told the prompt is back.
          if (onPrompt) { try { onPrompt(); } catch {} }
        } else if (body === 'C' || body.startsWith('C;')) {
          let cmd = '';
          try { cmd = Buffer.from(body.slice(2), 'base64').toString('utf8'); } catch { cmd = ''; }
          // A command whose payload did not survive is still a real command;
          // reporting it with an empty line is honest, dropping it is not.
          command = cmd;
          capturing = true;
          out = '';
        } else if (body === 'D' || body.startsWith('D;')) {
          // D without a preceding C is the shell's FIRST prompt (precmd runs
          // before any command has been typed) and every prompt redraw after an
          // abandoned line. Nothing ran, so there is nothing to report.
          if (capturing) {
            const raw = body.slice(2);
            const n = Number(raw);
            emit(raw !== '' && Number.isFinite(n) ? n : null);
          }
        }
      }
      const rest = s.slice(last);
      const p = rest.match(PARTIAL_RE);
      if (p && p.index + p[0].length === rest.length) {
        text(rest.slice(0, p.index));
        carry = p[0].length > MAX_CARRY ? '' : p[0];
      } else {
        text(rest);
      }
    },
    // Whether a command is open. The ONE piece of live state exposed, and only
    // as a boolean: an agent-driven exec must refuse to type while something is
    // already running rather than injecting a line into a program's stdin. The
    // command TEXT and the partial output stay private — a consumer that could
    // see a half-finished command would be tempted to report it before its exit
    // code exists.
    isBusy: () => capturing,
    // Test/diagnostic read.
    _state: () => ({ capturing, command, carry: carry.length, out: out.length }),
  };
}

// The agent-facing prose. Separate from the parser because it is PRODUCT — what
// the agent is told, and how much it costs — while the parser above is a fact
// reader.
//
// The exit code is most of the value and nearly free: "ran, exit 0" is often the
// entire answer at a handful of tokens. So output rides only when it is likely
// to be NEWS — a nonzero exit — and a successful command reports its line alone.
// A build that prints four thousand lines and works is not something the agent
// needs in its context.
function formatCommand(rec, { stripAnsi, maxLines, maxChars, always, assumed } = {}) {
  const cmd = String((rec && rec.command) || '').trim();
  // A record the shell did not NAME still has a real exit code and real output,
  // and which of those is worth keeping depends entirely on who is asking.
  //
  // The passive firehose passes no `assumed` and still drops the record: nobody
  // asked for it, and a report that cannot say what ran is not worth the
  // operator's privacy. A caller that KNOWS what it sent passes it here instead
  // of losing the answer to a missing label — measured against a real bash on
  // ubuntu 24.04, HISTCONTROL=ignoreboth makes every REPEATED command arrive
  // unnamed, so this was discarding correct output routinely rather than rarely.
  //
  // ASSUMED, NEVER REPORTED, and the wording carries that: drawer-pty's
  // `foreignRecord` tells our command from the operator's by comparing the
  // reported text, so an unnamed record is exactly the one it cannot vet. An
  // operator who pressed Enter inside the exec race window would have THEIR
  // output land here under our name, and a message that claimed the shell said
  // so would be a confident lie about whose work it is.
  const named = cmd || String(assumed || '').trim();
  if (!named) return null;
  // Read off a possibly-absent record: with `assumed` set, a caller can now get
  // past the guard above without one at all, and the old `rec.exitCode` threw.
  const code = rec && rec.exitCode;
  const status = code === null || code === undefined ? 'exit unknown' : `exit ${code}`;
  // THE MARKER RIDES THE LINE THE AGENT QUOTES, not just the parenthetical below
  // it. The argument is frequency rather than phrasing: on a stock ubuntu seat
  // HISTCONTROL=ignoreboth makes this the answer to every REPEATED command, and a
  // paragraph seen hourly gets skimmed while the `[terminal] …` line it quotes
  // back does not.
  const marker = cmd ? '' : ' (assumed)';
  const doubt = cmd ? '' : '\n(the shell did not name the command that finished — this is the command that was sent, assumed to be it. If your operator ran something at that moment, the output below may be theirs.)';
  const head = `[terminal] ${named}${marker}\n${status}${doubt}`;
  if (!always && (code === 0 || code === null || code === undefined)) return head;

  let body = String((rec && rec.output) || '');
  if (stripAnsi) body = stripAnsi(body);
  // Carriage returns are how a progress bar redraws one line; kept raw they
  // read as one enormous unreadable line in the transcript.
  body = body.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = body.split('\n');
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  // zsh's PROMPT_SP end-of-line marker: an inverse-video `%` padded to the
  // terminal width, printed when output did not end in a newline. It is emitted
  // by the shell CORE after the command finishes and BEFORE precmd hooks run, so
  // no hook ordering can keep it out of the capture — measured against a real
  // PTY, it landed at the tail of a failing `ls`. A display artifact, not
  // output. Bounded to the final line so a command legitimately printing `%`
  // mid-stream keeps it.
  if (lines.length && /^[%$#]\s*$/.test(lines[lines.length - 1])) lines.pop();
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  while (lines.length && !lines[0].trim()) lines.shift();
  if (!lines.length) return head;
  const cap = maxLines || 40;
  const trimmed = lines.length > cap;
  const kept = trimmed ? lines.slice(-cap) : lines;
  let text = kept.join('\n');
  const chars = maxChars || 4000;
  if (text.length > chars) text = `…\n${text.slice(-chars)}`;
  // The truncation is STATED. An agent reading a tail as if it were the whole
  // output will confidently describe a failure whose cause scrolled off.
  const note = trimmed ? ` (last ${kept.length} of ${lines.length} lines)` : '';
  return `${head}\noutput${note}:\n${text}`;
}

module.exports = { createMarkParser, formatCommand };
