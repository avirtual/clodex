const VOICE_MODES = ['off', 'tap'];
const DEFAULT_VOICE_MODE = 'tap';

function voiceModeOf(record) {
  return record && record.voice === 'off' ? 'off' : DEFAULT_VOICE_MODE;
}

module.exports = { VOICE_MODES, DEFAULT_VOICE_MODE, voiceModeOf };
