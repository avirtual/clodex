'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const voiceSettings = require('../voice-settings');
const { readVoiceTrigger, VOICE_MODES, DEFAULT_VOICE_MODE, voiceModeOf } = voiceSettings;
const { mkTmpRoot } = require('./lib/tmp-roots');

test('the modes offered are exactly the three /voice accepts', () => {
  assert.deepStrictEqual(VOICE_MODES, ['off', 'tap', 'hold']);
});

test('a seat record with no voice mode reads as tap', () => {
  assert.strictEqual(DEFAULT_VOICE_MODE, 'tap');
  assert.strictEqual(voiceModeOf(null), 'tap');
  assert.strictEqual(voiceModeOf({ name: 'a' }), 'tap');
  assert.strictEqual(voiceModeOf({ name: 'a', voice: 'bogus' }), 'tap');
});

test('a seat record carries its own voice mode', () => {
  for (const m of VOICE_MODES) assert.strictEqual(voiceModeOf({ name: 'a', voice: m }), m);
});

test('the settings-file voice read and write are gone', () => {
  assert.deepStrictEqual(Object.keys(voiceSettings).sort(), ['DEFAULT_VOICE_MODE', 'VOICE_MODES', 'readVoiceTrigger', 'voiceModeOf']);
});


function withKeys(body, fn) {
  const home = mkTmpRoot('clodex-keys-');
  try {
    if (body !== null) {
      fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
      fs.writeFileSync(path.join(home, '.claude', 'keybindings.json'),
        typeof body === 'string' ? body : JSON.stringify(body));
    }
    return fn(home);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test('no keybindings file means the CLI default: space', () => {
  withKeys(null, (home) => {
    const r = readVoiceTrigger({ homeDir: home });
    assert.deepStrictEqual(r.binding,
      { key: ' ', ctrl: false, alt: false, shift: false, meta: false, super: false });
    assert.strictEqual(r.custom, false);
  });
});

test('a rebound push-to-talk key is what gets written', () => {
  withKeys({ bindings: [{ context: 'Chat', bindings: { k: 'voice:pushToTalk' } }] }, (home) => {
    const r = readVoiceTrigger({ homeDir: home });
    assert.strictEqual(r.binding.key, 'k');
    assert.strictEqual(r.custom, true);
  });
});

test('a modifier chord is reported with its modifiers, for the caller to refuse', () => {
  withKeys({ bindings: [{ context: 'Chat', bindings: { 'meta+k': 'voice:pushToTalk' } }] }, (home) => {
    // Flattening this to 'k' here would lose exactly what makes it unwritable.
    assert.deepStrictEqual(readVoiceTrigger({ homeDir: home }).binding,
      { key: 'k', ctrl: false, alt: false, shift: false, meta: true, super: false });
  });
});

test('binding the default key to something ELSE leaves no trigger at all', () => {
  // The direction a scan that only looked for the action would miss: space is
  // now chat:stash, so no key arms push-to-talk and nothing may be written.
  withKeys({ bindings: [{ context: 'Chat', bindings: { space: 'chat:stash' } }] }, (home) => {
    const r = readVoiceTrigger({ homeDir: home });
    assert.strictEqual(r.binding, null);
    assert.strictEqual(r.custom, true);
  });
});

test('the LAST binding wins, as in the CLI', () => {
  withKeys({
    bindings: [{ context: 'Chat', bindings: { k: 'voice:pushToTalk', j: 'voice:pushToTalk' } }],
  }, (home) => {
    assert.strictEqual(readVoiceTrigger({ homeDir: home }).binding.key, 'j');
  });
});

test('a non-Chat context does not bind the chat trigger', () => {
  withKeys({ bindings: [{ context: 'Settings', bindings: { k: 'voice:pushToTalk' } }] }, (home) => {
    assert.strictEqual(readVoiceTrigger({ homeDir: home }).binding.key, ' ');
  });
});

test('a chord SEQUENCE is not a single chord and binds nothing', () => {
  withKeys({
    bindings: [{ context: 'Chat', bindings: { 'ctrl+x ctrl+e': 'voice:pushToTalk' } }],
  }, (home) => {
    // The CLI ignores the action unless the binding is one chord, so the
    // default stands rather than a half-parsed key.
    assert.strictEqual(readVoiceTrigger({ homeDir: home }).binding.key, ' ');
  });
});

test('a corrupt or unexpected keybindings file falls back to the default', () => {
  for (const body of ['{ not json', '[]', '{}', '{"bindings":"nope"}', '{"bindings":[null,3]}']) {
    withKeys(body, (home) => {
      const r = readVoiceTrigger({ homeDir: home });
      assert.strictEqual(r.binding.key, ' ', body);
      assert.strictEqual(r.custom, false, body);
    });
  }
});

test('the trigger read never writes, and never creates the file it missed', () => {
  withKeys(null, (home) => {
    readVoiceTrigger({ homeDir: home });
    assert.equal(fs.existsSync(path.join(home, '.claude')), false, 'no .claude/ created');
  });
});
