const path = require('path');
const os = require('os');
const { readJsonSafe } = require('./fs-util');

const VOICE_MODES = ['off', 'tap'];
const DEFAULT_VOICE_MODE = 'tap';

function voiceModeOf(record) {
  return record && record.voice === 'off' ? 'off' : DEFAULT_VOICE_MODE;
}

// The key that arms the CLI's recorder, read from `~/.claude/keybindings.json`.
// Reported as a PARSED CHORD rather than a character so the caller can tell
// "space" from "meta+k" — a modifier chord cannot be armed by writing a byte,
// and flattening it to a character here would lose exactly the distinction the
// caller needs to decline.
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

module.exports = { VOICE_MODES, DEFAULT_VOICE_MODE, voiceModeOf, readVoiceTrigger };
