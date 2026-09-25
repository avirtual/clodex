'use strict';

const VOICE_ENGINE_NAME = 'clodex-voice-engine';
const RECORD_KEY = ' ';
const BOOT_SETTLE_MS = 600;
const BOOT_MAX_MS = 20000;
const REPAINT_MAX_MS = 1500;
const RECORD_ACTIONS = ['start', 'stop', 'toggle'];
const PROMPT_MARK = '❯';
const RECORDING_INDICATOR = /\u23fa\u0020REC(?!\w)/u;
const PROCESSING_INDICATOR = /Voice:\s*processing/i;
const NO_SPEECH = /No speech detected/;
const SCREEN_RESET = '\x1b[H\x1b[2J\x1b[3J';

function engineSettings(wireBase) {
  if (typeof wireBase !== 'string' || !wireBase) throw new Error('voice engine needs a wire base');
  return { env: { ANTHROPIC_BASE_URL: `${wireBase}/anthropic` }, voice: { mode: 'tap' }, voiceEnabled: true };
}

function engineArgs(wireBase) {
  return ['--settings', JSON.stringify(engineSettings(wireBase))];
}

function planRecord({ mode, action, recording } = {}) {
  if (!RECORD_ACTIONS.includes(action)) return null;
  if (mode !== 'tap') return null;
  const was = recording === true;
  const want = action === 'toggle' ? !was : action === 'start';
  return { write: action === 'toggle' || want !== was, recording: want };
}

function recorderSelfStopped(chunk) {
  const text = String(chunk);
  return PROCESSING_INDICATOR.test(text) || NO_SPEECH.test(text);
}

module.exports = {
  VOICE_ENGINE_NAME, RECORD_KEY, BOOT_SETTLE_MS, BOOT_MAX_MS, REPAINT_MAX_MS,
  RECORD_ACTIONS, PROMPT_MARK, RECORDING_INDICATOR, PROCESSING_INDICATOR, NO_SPEECH, SCREEN_RESET,
  engineSettings, engineArgs, planRecord, recorderSelfStopped,
};
