// voice-settings.js — read the Claude CLI's PERSISTED voice-input state out of
// `~/.claude/settings.json`, for the voice-mode selector.
//
// READ-ONLY BY CONSTRUCTION. The mode is changed by running the CLI's own
// `/voice <mode>`, which owns the merge and the schema of the file it writes;
// nothing here needs a writer, so there is none to keep correct.
//
// A running CLI DOES pick up an external write — the mode is read through a
// live selector, not cached at startup — but only where the CLI is watching:
// it watches directories that had a settings file when that session started.
// A box whose ~/.claude/settings.json did not exist at session start is not
// covered, which is why the write is left to `/voice` rather than done here.
//
// The legacy sibling key `voiceEnabled` is REPORTED and never merged: `voice` is
// authoritative, so a file whose two keys disagree still reports `voice`, and a
// legacy-only file reports an UNKNOWN mode rather than a guessed one — a boolean
// cannot say tap from hold, and inventing one would put a checkmark on a row the
// CLI never chose. Nothing here repairs the file.
//
// Pure fs/os/path with an injectable homeDir — the genus of claude-env.js, so it
// is unit-testable against a temp dir with no engine and no Electron.

const path = require('path');
const os = require('os');
const { readJsonSafe } = require('./fs-util');

// The three modes `/voice` accepts. Order is the order the menu offers them.
const VOICE_MODES = ['off', 'tap', 'hold'];

// { file, source, mode, enabled, legacy, effective }
//   source    'voice' | 'legacy' | 'none' — which key shape the file carries
//   mode      a VOICE_MODES member, or null when absent/unrecognized
//   enabled   voice.enabled when boolean, else null
//   legacy    voiceEnabled when boolean, else null
//   effective what the UI selects: 'off' when voice.enabled is FALSE (the flag
//             gates the feature, whatever mode sits beside it), else `mode`
// An absent, unreadable, or corrupt file is not an error condition here: it is
// the ordinary state of a box that has never used voice, and readJsonSafe
// flattens all three to null so they answer source 'none' rather than throwing
// into a caller that would have to invent this same fallback.
function readVoiceMode({ homeDir = os.homedir() } = {}) {
  const file = path.join(homeDir, '.claude', 'settings.json');
  const data = readJsonSafe(file);
  const raw = data && typeof data === 'object' && !Array.isArray(data) ? data : null;
  const v = raw && typeof raw.voice === 'object' && raw.voice && !Array.isArray(raw.voice) ? raw.voice : null;
  const legacy = raw && typeof raw.voiceEnabled === 'boolean' ? raw.voiceEnabled : null;
  const mode = v && VOICE_MODES.includes(v.mode) ? v.mode : null;
  const enabled = v && typeof v.enabled === 'boolean' ? v.enabled : null;
  return {
    file,
    source: v ? 'voice' : (legacy === null ? 'none' : 'legacy'),
    mode,
    enabled,
    legacy,
    effective: enabled === false ? 'off' : mode,
  };
}

// The key that arms the CLI's recorder, read from `~/.claude/keybindings.json`.
// Same read-only genus as readVoiceMode, and same fallbacks: an absent file is
// the ordinary state, and `space` is what the CLI itself defaults the Chat
// binding for `voice:pushToTalk` to.
//
// Reported as a PARSED CHORD rather than a character so the caller can tell
// "space" from "meta+k" — a modifier chord cannot be armed by writing a byte,
// and flattening it to a character here would lose exactly the distinction the
// caller needs to decline. resolveTriggerKey in renderer/lib/voice-submit.js is
// what applies that rule.
//
// The CLI takes the LAST matching binding, so a file that binds the action
// twice resolves to the later one; a rebinding of the same key to another
// action drops it back to null. That is the same fold the CLI's own scan does.
function parseChord(spec) {
  if (typeof spec !== 'string' || !spec.trim()) return null;
  // A CHORD SEQUENCE is not a chord: the CLI ignores `voice:pushToTalk` unless
  // the binding is a single chord, so a space-separated pair has no key here.
  if (/\s/.test(spec.trim())) return null;
  const parts = spec.trim().toLowerCase().split('+');
  const key = parts.pop();
  if (!key) return null;
  const mods = new Set(parts);
  return {
    key: key === 'space' ? ' ' : key,
    ctrl: mods.has('ctrl'), alt: mods.has('alt'), shift: mods.has('shift'),
    meta: mods.has('meta') || mods.has('cmd'), super: mods.has('super'),
  };
}

// Both directions of the fold matter: a later entry can BIND the action to a
// new chord, and it can also take the current chord AWAY by giving it another
// action — a file that rebinds space to something else leaves no push-to-talk
// key at all. A scan that only looked for the action would report a space that
// no longer arms anything.
//
// The fold follows JS object key order, which is insertion order for these
// string keys; that is the order the entries appear in the file, not a
// re-derivation of the CLI's own precedence rules.
function sameChord(a, b) {
  return !!a && !!b && a.key === b.key && a.ctrl === b.ctrl && a.alt === b.alt
    && a.shift === b.shift && a.meta === b.meta && a.super === b.super;
}

function readVoiceTrigger({ homeDir = os.homedir() } = {}) {
  const file = path.join(homeDir, '.claude', 'keybindings.json');
  const data = readJsonSafe(file);
  const list = data && typeof data === 'object' && Array.isArray(data.bindings) ? data.bindings : [];

  // Seeded with the CLI's own default so a user file can CLEAR it, which is
  // the case an empty seed cannot express.
  let found = parseChord('space');
  let custom = false;

  for (const entry of list) {
    if (!entry || typeof entry !== 'object' || entry.context !== 'Chat') continue;
    const bindings = entry.bindings && typeof entry.bindings === 'object' ? entry.bindings : null;
    if (!bindings) continue;
    for (const [spec, action] of Object.entries(bindings)) {
      const chord = parseChord(spec);
      if (!chord) continue;
      if (action === 'voice:pushToTalk') { found = chord; custom = true; }
      else if (found && sameChord(chord, found)) { found = null; custom = true; }
    }
  }
  return { file, binding: found, custom };
}

module.exports = { VOICE_MODES, readVoiceMode, readVoiceTrigger };
