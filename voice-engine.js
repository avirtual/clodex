'use strict';

const VOICE_ENGINE_NAME = 'clodex-voice-engine';
const RECORD_KEY = ' ';
const HOLD_REPEAT_MS = 30;
const HOLD_MAX_MS = 120000;
const BOOT_SETTLE_MS = 600;
const BOOT_MAX_MS = 20000;
const REPAINT_MAX_MS = 1500;
const RECORD_ACTIONS = ['start', 'stop', 'toggle'];
const PROMPT_MARK = '❯';
const RECORDING_INDICATOR = /\u23fa\u0020REC(?!\w)/u;
const PROCESSING_INDICATOR = /Voice:\s*processing/i;
const NO_SPEECH = /No speech detected/i;

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

function recorderSelfStopped(chunk) {
  const text = String(chunk);
  return PROCESSING_INDICATOR.test(text) || NO_SPEECH.test(text);
}

module.exports = {
  VOICE_ENGINE_NAME, RECORD_KEY, HOLD_REPEAT_MS, HOLD_MAX_MS, BOOT_SETTLE_MS, BOOT_MAX_MS, REPAINT_MAX_MS,
  RECORD_ACTIONS, PROMPT_MARK, RECORDING_INDICATOR, PROCESSING_INDICATOR, NO_SPEECH,
  engineSettings, engineArgs, planRecord, recorderSelfStopped,
};
