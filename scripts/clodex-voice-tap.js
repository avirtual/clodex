#!/usr/bin/env node
'use strict';

// clodex-voice-tap.js — ask Clodex for a named voice action, from outside the app.
//
// For a macOS Voice Control custom command → shortcut → shell script:
//
//   node /path/to/clodex/scripts/clodex-voice-tap.js [seat-name]
//   node /path/to/clodex/scripts/clodex-voice-tap.js tap [seat-name]
//   node /path/to/clodex/scripts/clodex-voice-tap.js select <seat-name>
//   node /path/to/clodex/scripts/clodex-voice-tap.js mode tap|hold
//   node /path/to/clodex/scripts/clodex-voice-tap.js speech on|off
//
// A VERB NEEDS ITS ARGUMENT TO BE A VERB — one bare token is always a seat
// name, whatever it spells. That is what keeps every shortcut written against
// the older one-argument shape working unchanged, including one naming a seat
// called `tap`, `select`, `mode` or `speech`, and it costs the grammar nothing: a
// bare tap of the focused seat is the zero-argument form it always was.
//
// The name NEVER comes from speech. Voice Control matches a fixed phrase and
// runs a shortcut carrying the name as a literal, so N phrases on his side
// reach one script here — no transcription of an invented compound like
// `wirescope`, which is the surface that broke a spoken wake word before.
//
// WHY THIS EXISTS RATHER THAN Voice Control's own `press space key`: a
// keystroke goes to whatever app is frontmost, so with Clodex in the
// background the space lands in someone else's document. This is ADDRESSED —
// it reaches Clodex whatever has focus, and can name a seat.
//
// No seat name means the seat the operator is looking at, which the app tracks.
//
// ENSURE-ON, never a toggle: Voice Control cannot hear a wake word while the
// recorder is live, so the off half would have no reachable caller. Asking
// twice is harmless — the app declines when the recorder is already lit.
//
// THE APP DECIDES WHETHER A KEY IS WRITTEN, not this script and not the socket
// arm it reaches. Only the renderer can read the recording indicator, and on a
// screen it cannot read it writes nothing: a key sent into a live recording
// STOPS it, and losing the sentence the operator is speaking is far worse than
// making him say a wake word twice.
//
// SO A SUCCESSFUL RUN OF THIS SCRIPT IS NOT A TAP. It exits 0 once the envelope
// is delivered; whether a key followed is the renderer's call and is not
// reported back. The one cause seen in the field is the Claude CLI's fullscreen
// renderer (`/tui fullscreen`, or CLAUDE_CODE_NO_FLICKER=1), which puts the TUI
// on the alternate screen buffer and is sticky across restarts — the screen read
// then declines forever and this script is silently dead, while `select`, `mode`
// and `speech` keep working because they never scrape. `/tui` switches back.
// Diagnose from the voice popover: it reads 'Cannot read the screen' and its
// tooltip names the cause.
//
// Node builtins only, by the same rule as scripts/clodex-team.js: this runs
// from a shortcut with no install step and no dependency on the app's tree.

const fs = require('fs');
const net = require('net');
const path = require('path');
const os = require('os');

const CLODEX_HOME = process.env.CLODEX_HOME || path.join(os.homedir(), '.clodex');
const RUN_DIR = path.join(CLODEX_HOME, 'run');

function die(msg) {
  process.stderr.write(`clodex-voice-tap: ${msg}\n`);
  process.exit(1);
}

// Any live agent socket will do, and that is not a shortcut: `voice-tap` is a
// BOX-WIDE request that rides the only local-user-only pipe Clodex listens on
// (~/.clodex is 0700, each socket 0600). The socket it arrives on identifies
// the app, never the seat acted on — that is `target`, or the focused seat.
function* candidateSockets() {
  let names;
  try { names = fs.readdirSync(RUN_DIR); } catch { return; }
  for (const name of names) {
    if (name.startsWith('.')) continue;
    let info;
    try {
      info = JSON.parse(fs.readFileSync(path.join(RUN_DIR, name, 'agent.json'), 'utf-8'));
    } catch { continue; }
    if (!info || typeof info.socket !== 'string') continue;
    if (!fs.existsSync(info.socket)) continue;
    yield info.socket;
  }
}

// One JSON write then end — the envelope shape Transport's receiver decodes.
// Resolves false rather than throwing on a dead socket: a registry entry can
// outlive its process after an unclean shutdown, and the next candidate is the
// answer to that, not an error message to the operator.
function send(socketPath, envelope) {
  return new Promise((resolve) => {
    const conn = net.createConnection(socketPath, () => {
      conn.end(JSON.stringify(envelope), () => done(true));
    });
    conn.on('error', () => done(false));
    // CLEARED on both settled paths, and that is latency the operator feels: an
    // uncleared timer keeps the event loop alive for its full 2s AFTER the send
    // succeeded, so every wake word would pay that before the shortcut returns.
    const timer = setTimeout(() => { conn.destroy(); resolve(false); }, 2000);
    function done(ok) { clearTimeout(timer); resolve(ok); }
  });
}

// argv → envelope, or an error string. Split out from the send so the grammar
// is testable without a socket.
//
// The ONE-TOKEN RULE (see the header) is the compatibility hinge: a verb is
// recognised only with an argument after it, so every legacy invocation —
// bare, or with any seat name — takes the tap arm and builds the byte-identical
// envelope it always did.
function envelopeFor(args) {
  const [first, second] = args;
  if (args.length >= 2) {
    if (first === 'select') {
      // An unset shell variable — `select "$SEAT"` — arrives as an empty
      // string, which is a present argument. Refused here so the shortcut
      // fails where he can see it; the manager refuses it too, because the
      // socket is the boundary a second front-end would also cross.
      if (!second.trim()) return { error: 'select needs a seat name' };
      // No focused-seat fallback, here or in the app: he is looking at another
      // application by construction, so a select that silently landed on the
      // seat he already had would have him dictating into the wrong agent
      // believing he switched. Silence is the safe failure.
      return { type: 'voice-select', from: 'voice-tap', target: second };
    }
    if (first === 'mode') {
      if (second !== 'tap' && second !== 'hold') return { error: `mode takes tap|hold, got "${second}"` };
      return { type: 'voice-mode', from: 'voice-tap', mode: second };
    }
    if (first === 'speech') {
      // Explicit on|off, never a toggle: he cannot see the current state from
      // across the room, so a toggle fired on a mis-hear leaves him unsure
      // which state he is in and repeating it flips back.
      if (second !== 'on' && second !== 'off') return { error: `speech takes on|off, got "${second}"` };
      return { type: 'voice-speech', from: 'voice-tap', state: second };
    }
    // An UNSET shell variable (`tap "$SEAT"`) degrades to the explicit bare
    // tap rather than a named one: `voiceTap('')` reaching the focused seat is
    // the tap's own documented default, but arriving there through a name he
    // believes he supplied is the shell-variable hole `select` closes.
    if (first === 'tap') {
      return second.trim()
        ? { type: 'voice-tap', from: 'voice-tap', target: second }
        : { type: 'voice-tap', from: 'voice-tap' };
    }
    return { error: `unknown verb "${first}" (use tap|select|mode|speech)` };
  }
  const target = first || null;
  return { type: 'voice-tap', from: 'voice-tap', ...(target ? { target } : {}) };
}

async function main() {
  const envelope = envelopeFor(process.argv.slice(2));
  if (envelope.error) die(envelope.error);

  for (const socketPath of candidateSockets()) {
    if (await send(socketPath, envelope)) return;
  }
  // Every agent socket is a per-AGENT socket, so a box with no agent session
  // running has nothing listening and nothing to tap.
  die(`no live Clodex agent socket under ${RUN_DIR}`);
}

// Guarded so a test can require this file for `envelopeFor` without the require
// itself firing a socket send. Running it as a script is unchanged.
if (require.main === module) main().catch((e) => die(e.message));

module.exports = { envelopeFor };
