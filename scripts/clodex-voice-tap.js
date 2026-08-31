#!/usr/bin/env node
'use strict';

// clodex-voice-tap.js — ask Clodex to start recording, from outside the app.
//
// For a macOS Voice Control custom command → shortcut → shell script:
//
//   node /path/to/clodex/scripts/clodex-voice-tap.js [seat-name]
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

async function main() {
  const target = process.argv[2] || null;
  const envelope = { type: 'voice-tap', from: 'voice-tap', ...(target ? { target } : {}) };

  for (const socketPath of candidateSockets()) {
    if (await send(socketPath, envelope)) return;
  }
  // Every agent socket is a per-AGENT socket, so a box with no agent session
  // running has nothing listening and nothing to tap.
  die(`no live Clodex agent socket under ${RUN_DIR}`);
}

main().catch((e) => die(e.message));
