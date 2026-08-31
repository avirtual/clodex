// voice-settings.js — read and write the Claude CLI's PERSISTED voice-input
// state in `~/.claude/settings.json`, for the voice-mode selector.
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
const fs = require('fs');
const { readJsonSafe, atomicWriteFileSync } = require('./fs-util');

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

// Set the mode by writing the file the CLI reads, mirroring what its own
// `/voice` handler writes. The two arms write DIFFERENT SHAPES, both measured
// from the 2.1.252 binary:
//
//   off:      rn("userSettings", { voiceEnabled: false,
//                                  voice: { ...existing.voice, enabled: false } })
//   tap/hold: rn("userSettings", { voiceEnabled: true,
//                                  voice: { ...existing.voice, enabled: true, mode } })
//
// OFF LEAVES `mode` ALONE, and normalising it here would diverge from the CLI
// over a file they share: `enabled` is the gate and the mode sits beside it
// untouched, which is why readVoiceMode's `effective` reports 'off' on
// `enabled === false` whatever mode it finds. Clearing the mode would also lose
// which of tap/hold to return to.
//
// READ-MODIFY-WRITE, and every part of that matters. This is the user's GLOBAL
// CLI settings file and holds far more than voice: unrelated top-level keys are
// carried through untouched, and `voice`'s own siblings (autoSubmit, language,
// whatever a later CLI adds) survive the spread. A whole-object write here would
// silently delete the rest of their configuration.
//
// `enabled: true` is not incidental — a mode change also turns voice input ON
// when it was off, which is exactly what `/voice` does. Matching the handler is
// the point; diverging would make our write and theirs disagree about a file
// they share. `voiceEnabled` rides along for the same reason: the CLI writes
// both, and readVoiceMode above has opinions about a file where they disagree.
//
// The GLOBAL file only. A per-agent `--settings` file is the CLI's flagSettings
// layer, which `/voice` explicitly no-ops on, so writing a mode there would
// produce a file the CLI never honors.
//
// Two limits this cannot fix, both accepted: a seat launched with
// CLAUDE_CONFIG_DIR elsewhere reads a different file and never sees this (Clodex
// sets that for no seat); and the CLI's watcher only covers directories that had
// a settings file when that session started, so CREATING this file will not
// reach an already-running seat — the write lands, that seat does not move.
//
// WRITE ONLY WHERE WE COULD MERGE, OR WHERE THERE IS NOTHING TO LOSE. This does
// its own read and parse rather than going through readJsonSafe, which cannot
// distinguish "no file" from "file we could not parse" — and that distinction is
// the whole safety property. Merging onto `{}` is right for an absent file and
// catastrophic for an unparseable one: this is the user's global CLI settings,
// so a mode verb fired while a hand-edit is mid-typo would replace every key in
// it with a two-key object. The CLI declines the same case ("Check your settings
// file for syntax errors") rather than overwriting.
function writeVoiceMode(mode, { homeDir = os.homedir() } = {}) {
  if (mode !== 'off' && mode !== 'tap' && mode !== 'hold') return { ok: false, error: `unknown voice mode "${mode}" (use off|tap|hold)` };
  const file = path.join(homeDir, '.claude', 'settings.json');

  let text = null;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    // ENOENT is the ordinary never-used-voice box. Any other read failure means
    // a file IS there and we cannot see it, which is the case we must not write
    // over — an EACCES treated as absent would clobber on the next chmod.
    if (e.code !== 'ENOENT') {
      return { ok: false, error: `${file} could not be read (${e.code || e.message}) — voice mode not changed` };
    }
  }

  let base = {};
  if (text !== null && text.trim() !== '') {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { ok: false, error: `${file} has a syntax error — voice mode not changed` };
    }
    // Legible JSON that is not an object (`[]`, `null`, a bare string or number)
    // is refused for the same reason as a syntax error rather than merged onto
    // `{}`: it is not a settings file we can add a key to, so writing means
    // discarding whatever the user does have there. One rule covers both — we
    // only ever write where the existing content can carry our keys.
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, error: `${file} is not a JSON object — voice mode not changed` };
    }
    base = parsed;
  }

  // WRITE THROUGH THE SYMLINK, not over it. atomicWriteFileSync renames onto the
  // path it is given, so handing it a symlinked settings.json (a dotfiles repo,
  // or a symlinked ~/.claude) would REPLACE the link with a regular file: the
  // repo silently stops driving the setting and the next sync reverts the mode,
  // with nothing in the result or the log saying so. Same genus as refusing an
  // unparseable file — a write that discards the structure the user has.
  //
  // The result keeps reporting `file`, the path the caller asked about; `target`
  // is where the bytes land.
  let target = file;
  try {
    target = fs.realpathSync(file);
  } catch {
    // realpath fails for an absent file (ordinary: fall through and create it)
    // and for a DANGLING link, which is not ordinary — a link whose target is
    // missing or unmounted is still a structure the user put there deliberately,
    // and writing would convert it to a regular file. Refuse instead: this is
    // the one case where falling back to `file` destroys something.
    let dangling = false;
    try { dangling = fs.lstatSync(file).isSymbolicLink(); } catch { dangling = false; }
    if (dangling) {
      return { ok: false, error: `${file} is a symlink whose target cannot be resolved — voice mode not changed` };
    }
  }

  const v = base.voice && typeof base.voice === 'object' && !Array.isArray(base.voice) ? base.voice : {};
  const next = mode === 'off'
    ? { ...base, voiceEnabled: false, voice: { ...v, enabled: false } }
    : { ...base, voiceEnabled: true, voice: { ...v, enabled: true, mode } };
  try {
    atomicWriteFileSync(target, `${JSON.stringify(next, null, 2)}\n`);
  } catch (e) {
    return { ok: false, error: e.message };
  }
  return { ok: true, mode, file };
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

module.exports = { VOICE_MODES, readVoiceMode, writeVoiceMode, readVoiceTrigger };
