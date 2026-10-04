const VOICE_MODES = ['off', 'tap'];
const DEFAULT_VOICE_MODE = 'tap';

function voiceModeOf(record) {
  if (record && record.voice === 'off') return 'off';
  if (record && record.voice === 'tap') return 'tap';
  return record && record.ephemeral === true ? 'off' : DEFAULT_VOICE_MODE;
}

module.exports = { VOICE_MODES, DEFAULT_VOICE_MODE, voiceModeOf };
