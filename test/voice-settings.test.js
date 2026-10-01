'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const voiceSettings = require('../voice-settings');
const { VOICE_MODES, DEFAULT_VOICE_MODE, voiceModeOf } = voiceSettings;

test('a seat\u2019s voice is on or off: exactly two modes', () => {
  assert.deepStrictEqual(VOICE_MODES, ['off', 'tap']);
});

test('a seat record with no voice mode reads as tap', () => {
  assert.strictEqual(DEFAULT_VOICE_MODE, 'tap');
  assert.strictEqual(voiceModeOf(null), 'tap');
  assert.strictEqual(voiceModeOf({ name: 'a' }), 'tap');
  assert.strictEqual(voiceModeOf({ name: 'a', voice: 'bogus' }), 'tap');
});

test('a seat record carries its own voice mode', () => {
  assert.strictEqual(voiceModeOf({ name: 'a', voice: 'off' }), 'off');
  assert.strictEqual(voiceModeOf({ name: 'a', voice: 'tap' }), 'tap');
});

test('a record persisted as hold reads as on (tap), with no migration', () => {
  const rec = { name: 'a', voice: 'hold' };
  assert.strictEqual(voiceModeOf(rec), 'tap');
  assert.strictEqual(rec.voice, 'hold');
});

test('the settings-file voice read and write are gone', () => {
  assert.deepStrictEqual(Object.keys(voiceSettings).sort(), ['DEFAULT_VOICE_MODE', 'VOICE_MODES', 'voiceModeOf']);
});
