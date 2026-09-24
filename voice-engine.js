'use strict';

const VOICE_ENGINE_NAME = 'clodex-voice-engine';
const RECORD_KEY = ' ';
const HOLD_REPEAT_MS = 30;
const HOLD_MAX_MS = 120000;
const BOOT_SETTLE_MS = 600;
const BOOT_MAX_MS = 20000;
const RECORD_ACTIONS = ['start', 'stop', 'toggle'];
const PROMPT_MARK = '❯';

function engineSettings(wireBase) {
  if (typeof wireBase !== 'string' || !wireBase) throw new Error('voice engine needs a wire base');
  return { env: { ANTHROPIC_BASE_URL: `${wireBase}/anthropic` } };
}

function engineArgs(wireBase) {
  return ['--settings', JSON.stringify(engineSettings(wireBase))];
}

function planRecord({ mode, action, recording } = {}) {
  if (!RECORD_ACTIONS.includes(action)) return null;
  if (mode !== 'tap' && mode !== 'hold') return null;
  const was = recording === true;
  const want = action === 'toggle' ? !was : action === 'start';
  if (mode === 'tap') {
    const write = action === 'toggle' || want !== was;
    return { write, hold: null, recording: want };
  }
  return { write: false, hold: want ? 'start' : 'stop', recording: want };
}

module.exports = {
  VOICE_ENGINE_NAME, RECORD_KEY, HOLD_REPEAT_MS, HOLD_MAX_MS, BOOT_SETTLE_MS, BOOT_MAX_MS,
  RECORD_ACTIONS, PROMPT_MARK, engineSettings, engineArgs, planRecord,
};
