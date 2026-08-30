'use strict';

// voice-trigger-ipc.test.js — the ONE hop the voice suite left open: the
// `settings:voiceMode` payload key the push-to-talk re-arm reads the binding
// from. `voice-settings.test.js` pins what readVoiceTrigger returns and
// `voice-core.test.js` pins that the core reads `state.trigger.binding`, but
// both fixtures WRITE the key name they assert, so both stay green if the
// handler spells it anything else — and the re-arm's only failure mode is
// silence, so nothing else would report it either.
//
// A new file rather than a case in either of those: this drives BOTH halves
// against each other, so it needs the main-side handler (which voice-core.test
// never requires) and the renderer core (which voice-settings.test never
// requires) in one process, over a real temp HOME.
//
// Nothing here may rebuild the payload itself. The handler's own object
// literal is the thing under test; a fixture that constructs `{ trigger: … }`
// would assert only that the test agrees with itself.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { registerIpcHandlers } = require('../ipc-handlers');
const { readVoiceMode, readVoiceTrigger } = require('../voice-settings');
const { createVoiceCore } = require('../renderer/voice-control');

// ctrl+j, not the CLI's default space: a payload that lost the user's file and
// fell back to the seeded default would still carry a `binding`, and asserting
// the default could not tell those apart.
const CHORD = 'ctrl+j';
const PARSED = { key: 'j', ctrl: true, alt: false, shift: false, meta: false, super: false };

// A real HOME on disk with both files the two readers open — no fs stubbing, so
// a change to either read path surfaces here rather than only on a live box.
function withHome(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'clodex-voice-ipc-'));
  const dir = path.join(home, '.claude');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'settings.json'),
    JSON.stringify({ voice: { enabled: true, mode: 'tap' } }));
  fs.writeFileSync(path.join(dir, 'keybindings.json'),
    JSON.stringify({ bindings: [{ context: 'Chat', bindings: { [CHORD]: 'voice:pushToTalk' } }] }));
  try { return fn(home); } finally { fs.rmSync(home, { recursive: true, force: true }); }
}

// The real handler registration, with only the two readers this channel calls
// pointed at the temp HOME. Everything else the module destructures is absent,
// exactly as in env-scopes-ipc.test.js.
function voiceModeHandler(home) {
  const handlers = new Map();
  registerIpcHandlers({
    handle: (ch, fn) => handlers.set(ch, fn),
    on: (ch, fn) => handlers.set(ch, fn),
    readVoiceMode: () => readVoiceMode({ homeDir: home }),
    readVoiceTrigger: () => readVoiceTrigger({ homeDir: home }),
    log: { info() {}, error() {} },
  });
  const fn = handlers.get('settings:voiceMode');
  assert.ok(fn, 'settings:voiceMode is registered — without this the assertions below read around a missing channel');
  return fn;
}

test('settings:voiceMode carries the push-to-talk chord at trigger.binding — the whole payload, as the handler builds it', () => {
  withHome((home) => {
    const payload = voiceModeHandler(home)();
    // The WHOLE object: a rename of `trigger` to anything else fails here even
    // though `payload.someOtherName.binding.key` would still be 'j'.
    assert.deepStrictEqual(payload, {
      ok: true,
      file: path.join(home, '.claude', 'settings.json'),
      source: 'voice',
      mode: 'tap',
      enabled: true,
      legacy: null,
      effective: 'tap',
      trigger: {
        file: path.join(home, '.claude', 'keybindings.json'),
        binding: PARSED,
        custom: true,
      },
    });
  });
});

// The consuming half, fed the REAL payload rather than a fixture of one. This
// is what makes a rename in ipc-handlers.js fail as a broken FEATURE and not
// merely a changed literal: triggerBinding() goes null, which on a live box is
// a re-arm that declines forever and says nothing.
test('the renderer core resolves that same payload to the chord — no re-arm without it', async () => {
  const prevWindow = global.window;
  const prevObserver = global.MutationObserver;
  global.MutationObserver = class { observe() {} disconnect() {} };
  try {
    await withHome(async (home) => {
      const handler = voiceModeHandler(home);
      global.window = {
        addEventListener() {},
        api: { async getVoiceMode() { return handler(); } },
      };
      const core = createVoiceCore({
        getActiveSession: () => 'a',
        sessionTypeOf: () => 'claude',
        sessionList: { querySelectorAll: () => [], querySelector: () => null },
        showToast: () => {},
      });
      await core.refresh();
      assert.deepStrictEqual(core.triggerBinding(), PARSED);
    });
  } finally {
    global.window = prevWindow;
    global.MutationObserver = prevObserver;
  }
});
