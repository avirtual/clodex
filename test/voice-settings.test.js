'use strict';
// voice-settings.test.js — the main-side read behind the voice-mode
// selector (t509). The control's whole claim is that it reflects the FILE rather
// than what Clodex last injected, so what is worth pinning is the mapping from
// every file shape a real box can be in onto the mode the UI selects.
//
// Each case writes a REAL settings.json into a temp HOME and reads it back
// through the injected homeDir — no fs stubbing, so a change to the key path or
// to readJsonSafe's tolerance shows up here rather than only on a live box.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { readVoiceMode, VOICE_MODES } = require('../voice-settings');

// A temp HOME whose .claude/settings.json holds `body` verbatim (a string is
// written raw, so a case can express a CORRUPT file — the one shape JSON.stringify
// cannot produce). `body === null` writes no file at all.
function withHome(body, fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'clodex-voice-'));
  try {
    if (body !== null) {
      fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
      fs.writeFileSync(
        path.join(home, '.claude', 'settings.json'),
        typeof body === 'string' ? body : JSON.stringify(body, null, 2),
      );
    }
    return fn(readVoiceMode({ homeDir: home }), home);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test('the modes offered are exactly the three /voice accepts', () => {
  assert.deepStrictEqual(VOICE_MODES, ['off', 'tap', 'hold']);
});

// Each row carries its expected mode/effective as a LITERAL rather than reading
// it back out of the input: an expectation computed by the code's own rule would
// agree with a broken reader on every row, and could not express the two rows
// that are deliberately NOT their input (enabled:false, and the legacy-only file).
const CASES = [
  {
    what: 'mode off',
    body: { voice: { enabled: true, mode: 'off' } },
    expect: { source: 'voice', mode: 'off', enabled: true, legacy: null, effective: 'off' },
  },
  {
    what: 'mode tap (the shape on Bogdan\'s box)',
    body: { voice: { enabled: true, mode: 'tap' }, voiceEnabled: true },
    expect: { source: 'voice', mode: 'tap', enabled: true, legacy: true, effective: 'tap' },
  },
  {
    what: 'mode hold',
    body: { voice: { enabled: true, mode: 'hold' } },
    expect: { source: 'voice', mode: 'hold', enabled: true, legacy: null, effective: 'hold' },
  },
  {
    // The flag gates the feature whatever mode sits beside it, so the UI must
    // select Off — not the stored 'hold', which would put a checkmark on a row
    // the CLI is not honouring.
    what: 'disabled with a mode still stored reads as off',
    body: { voice: { enabled: false, mode: 'hold' } },
    expect: { source: 'voice', mode: 'hold', enabled: false, legacy: null, effective: 'off' },
  },
  {
    // `voice` wins and the legacy key is reported, never merged and never repaired.
    what: 'the legacy key disagreeing does not move the answer',
    body: { voice: { enabled: true, mode: 'hold' }, voiceEnabled: false },
    expect: { source: 'voice', mode: 'hold', enabled: true, legacy: false, effective: 'hold' },
  },
  {
    // A boolean cannot say tap from hold, so the mode stays UNKNOWN. The UI shows
    // no selection rather than a guessed one.
    what: 'legacy key only leaves the mode unknown',
    body: { voiceEnabled: true },
    expect: { source: 'legacy', mode: null, enabled: null, legacy: true, effective: null },
  },
  {
    what: 'absent file',
    body: null,
    expect: { source: 'none', mode: null, enabled: null, legacy: null, effective: null },
  },
  {
    what: 'corrupt file',
    body: '{ "voice": { "mode": "ta',
    expect: { source: 'none', mode: null, enabled: null, legacy: null, effective: null },
  },
  {
    what: 'settings.json with no voice keys at all',
    body: { model: 'opus', permissions: { deny: [] } },
    expect: { source: 'none', mode: null, enabled: null, legacy: null, effective: null },
  },
  {
    // A mode string the CLI never writes must not reach the UI as a selection:
    // an unrecognized value is unknown, the same as absent.
    what: 'unrecognized mode value',
    body: { voice: { enabled: true, mode: 'whisper' } },
    expect: { source: 'voice', mode: null, enabled: true, legacy: null, effective: null },
  },
  {
    // Wrong TYPES on both keys — a hand-edited file. Neither may crash the read
    // nor be coerced into a selection.
    what: 'voice is not an object',
    body: { voice: 'tap', voiceEnabled: 'yes' },
    expect: { source: 'none', mode: null, enabled: null, legacy: null, effective: null },
  },
];

for (const c of CASES) {
  test(`readVoiceMode: ${c.what}`, () => {
    withHome(c.body, (got, home) => {
      // Assert the WHOLE object, not the interesting field: a shape that grew a
      // key the UI reads would otherwise pass every row here unmentioned.
      assert.deepStrictEqual(got, {
        file: path.join(home, '.claude', 'settings.json'),
        ...c.expect,
      });
    });
  });
}

test('the read never writes, and never creates the file it missed', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'clodex-voice-'));
  try {
    readVoiceMode({ homeDir: home });
    assert.equal(fs.existsSync(path.join(home, '.claude')), false, 'no .claude/ created');
    fs.mkdirSync(path.join(home, '.claude'));
    const f = path.join(home, '.claude', 'settings.json');
    const bytes = JSON.stringify({ voice: { enabled: true, mode: 'tap' }, voiceEnabled: true });
    fs.writeFileSync(f, bytes);
    readVoiceMode({ homeDir: home });
    // The legacy key in particular must survive untouched — the ruling is that
    // Clodex does not "repair" a file whose two keys disagree.
    assert.equal(fs.readFileSync(f, 'utf8'), bytes, 'settings.json is byte-identical after a read');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
