// voice-settings.js — read the Claude CLI's PERSISTED voice-input state out of
// `~/.claude/settings.json`, for the sidebar's voice-mode selector.
//
// READ-ONLY BY CONSTRUCTION, and that is the whole design. The mode is changed
// by INJECTING `/voice <mode>` into a live session; a running CLI reads the file
// at its own startup and holds the mode in memory, so a writer here would leave
// the UI asserting a state no session is actually in.
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

module.exports = { VOICE_MODES, readVoiceMode };
