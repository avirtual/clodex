// speaker.js — owns the one `say` process, and every rule about when it may run.
//
// WHY CLODEX SPEAKS AND NOT THE AGENT: a tool call the agent makes lives inside
// its turn, and the speech has to outlive the turn. An agent that ran `say`
// would also be free to decide what and when, which is the opposite of a
// setting the operator controls.
//
// FULLY LOCAL. /usr/bin/say synthesizes on the machine; no audio and no text
// leaves the box. That is the sharp contrast with dictation, where the CLI
// streams microphone PCM upstream to be transcribed, and it is a privacy
// PROPERTY of this feature rather than an implementation detail.
//
// SPAWNED, NEVER SHELL-INTERPOLATED. The text comes from a model, so a `$(...)`
// or a backtick in a shell string would be a command-injection hole. execFile
// with the text as an argv element has no shell to interpret it, and `--` stops
// a reply that opens with a hyphen from being read as a flag.

const { execFile, execFileSync } = require('child_process');

const SAY_BIN = '/usr/bin/say';

// The voice ships as a NAME ONLY, never a variant. `say -v Daniel` resolves to
// whichever Daniel is installed, so the free enhanced download upgrades the
// output with no code change here. Do not pin a fidelity and do not probe for
// one: an unknown name makes `say` fall back to the system voice and still
// speak (verified: exit 0, audio produced), which is the degradation this
// feature wants over silence or a throw.
//
// Daniel (en_GB) is the default because it was the CLEAREST across a room in
// the operator's own listening test — clarity is the selection criterion here,
// not warmth. A friendlier default is a regression for the use it was built for.
const DEFAULT_VOICE = 'Daniel';

// `say -v '?'` lines are `Name <spaces> locale <spaces> # sample`. A name may
// contain spaces ("Eddy (English (UK))") AND a long name is followed by only a
// single space, so neither the first whitespace run nor a fixed column finds the
// boundary. The locale token is the anchor, pinned by the `#` that follows it.
const VOICE_LINE = /^(.+?)\s+([a-z]{2}_[A-Z]{2})\s+#/;

// ENUMERATED, NEVER LISTED FROM MEMORY. The installed set is far smaller than
// macOS documentation suggests and differs per box — six usable English voices
// on the machine this was built for, while names recalled from general
// knowledge (Tom, Ava, Serena) are simply absent. A hardcoded list would offer
// voices that do not exist, and `say` does not report that: it SUBSTITUTES the
// system voice and exits 0, so the operator would hear the wrong voice with no
// error anywhere. Enumerating is the only way to offer a name that will be
// honoured.
function listVoices({ execFileSyncImpl = execFileSync, bin = SAY_BIN, lang = 'en' } = {}) {
  let raw;
  try {
    raw = String(execFileSyncImpl(bin, ['-v', '?'], { encoding: 'utf-8', timeout: 5000 }));
  } catch { return []; }
  const out = [];
  for (const line of raw.split('\n')) {
    const m = VOICE_LINE.exec(line);
    if (!m) continue;
    const name = m[1].trim();
    const locale = m[2];
    if (lang && !locale.startsWith(`${lang}_`)) continue;
    out.push({ name, locale });
  }
  return out;
}

function createSpeaker({ execFileImpl = execFile, bin = SAY_BIN } = {}) {
  let child = null;

  function stop() {
    if (!child) return false;
    const c = child;
    // Cleared BEFORE the kill so the exit handler cannot null out a NEWER child:
    // kill() is async and speak() may start a replacement before SIGTERM lands.
    child = null;
    try { c.kill(); } catch { /* already gone */ }
    return true;
  }

  // The recorder just lit while a narration was playing. KILL IT: he tapped the
  // microphone because he wants to talk, and being talked over by the machine is
  // the annoyance he would have to sit through. Letting it finish was the
  // considered alternative — it keeps the reply intact — but it bounds the
  // damage the wrong way round, holding the floor for up to the full utterance
  // against someone actively trying to speak.
  //
  // A NAMED function on purpose: this is a decision, and a decision that exists
  // only as the placement of a stop() call cannot be found by the next reader
  // wondering why the narration cuts out.
  function interruptForRecorder() {
    return stop();
  }

  // One utterance at a time. A second turn ending mid-narration REPLACES the
  // first rather than queueing behind it: the newer reply is the one the
  // operator is waiting on, and a queue would fall further behind on every turn
  // until it narrated the distant past.
  function speak(text, { voice = DEFAULT_VOICE } = {}) {
    if (!text) return false;
    stop();
    const args = [];
    if (voice) args.push('-v', voice);
    args.push('--', text);
    let started;
    try {
      started = execFileImpl(bin, args, () => {
        // Consume-only: a missing binary, a killed process and a synthesis
        // failure all arrive here, and none of them is worth interrupting the
        // operator over. Guarded against nulling a successor for the same
        // reason stop() clears first.
        if (child === started) child = null;
      });
    } catch {
      child = null;
      return false;
    }
    child = started;
    return true;
  }

  return { speak, stop, interruptForRecorder, isSpeaking: () => !!child };
}

module.exports = { createSpeaker, listVoices, DEFAULT_VOICE, SAY_BIN };
