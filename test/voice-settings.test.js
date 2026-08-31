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

const { readVoiceMode, writeVoiceMode, readVoiceTrigger, VOICE_MODES } = require('../voice-settings');

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

// ------------------------------------------------------- push-to-talk binding
// The key the re-arm writes (t571). It must be the CONFIGURED one: the CLI
// resolves its trigger from the Chat binding for `voice:pushToTalk`, and a box
// that rebound it would otherwise get a space typed into its composer.

// A temp HOME whose .claude/keybindings.json holds `body`. Same shape as
// withHome above; kept separate because it writes a different file.
function withKeys(body, fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'clodex-keys-'));
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

// THE WRITE. `mode` changes the CLI's push-to-talk setting by writing
// this file rather than by injecting `/voice`, so what these pin is that the
// write mirrors the CLI's own handler and cannot damage the file around it.
//
// The file is the user's GLOBAL CLI settings and holds far more than voice, so
// the destructive failure — clobbering an unrelated key — is the one worth the
// most assertions. Real files in a temp HOME, same genus as the reads above.
//
// NOT PINNED HERE, because nothing in this process can observe it: that a
// RUNNING CLI picks the write up. That was established by Bogdan editing the
// file by hand under a live session and watching it move; a fixture claiming it
// would be asserting a state it cannot reach.
function withWrite(body, fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'clodex-voicew-'));
  try {
    if (body !== null) {
      fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
      fs.writeFileSync(
        path.join(home, '.claude', 'settings.json'),
        typeof body === 'string' ? body : JSON.stringify(body, null, 2),
      );
    }
    const file = path.join(home, '.claude', 'settings.json');
    return fn({
      home,
      file,
      write: (mode) => writeVoiceMode(mode, { homeDir: home }),
      read: () => JSON.parse(fs.readFileSync(file, 'utf8')),
      // RAW BYTES, because the refusal cases claim the file was not touched at
      // all. A parsed comparison would call a rewrite with reordered keys or a
      // changed indent "unchanged", which is most of what a bad write looks like.
      bytes: () => fs.readFileSync(file),
    });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test('writeVoiceMode sets the mode and turns voice on, mirroring /voice', () => {
  withWrite({ voice: { mode: 'hold', enabled: false } }, (t) => {
    assert.deepStrictEqual(t.write('tap'), { ok: true, mode: 'tap', file: t.file });
    const d = t.read();
    assert.strictEqual(d.voice.mode, 'tap');
    // enabled:true is deliberate and matches the CLI handler: setting a mode
    // also un-mutes voice input. A write that left `enabled:false` would leave
    // the UI showing a mode that does nothing.
    assert.strictEqual(d.voice.enabled, true);
    assert.strictEqual(d.voiceEnabled, true);
  });
});

test('writeVoiceMode preserves voice siblings and every unrelated top-level key', () => {
  const before = {
    model: 'opus',
    env: { FOO: '1' },
    permissions: { allow: ['Bash'] },
    voice: { mode: 'hold', enabled: true, autoSubmit: true, language: 'en' },
  };
  withWrite(before, (t) => {
    t.write('tap');
    const d = t.read();
    // The whole object, not a spot check: a partial assertion here would read
    // around exactly the key a future spread forgot to carry.
    assert.deepStrictEqual(d, {
      model: 'opus',
      env: { FOO: '1' },
      permissions: { allow: ['Bash'] },
      voiceEnabled: true,
      voice: { mode: 'tap', enabled: true, autoSubmit: true, language: 'en' },
    });
  });
});

test('writeVoiceMode round-trips through readVoiceMode', () => {
  withWrite({ voice: { mode: 'hold', enabled: true } }, (t) => {
    t.write('tap');
    const r = readVoiceMode({ homeDir: t.home });
    assert.strictEqual(r.mode, 'tap');
    assert.strictEqual(r.effective, 'tap', 'the selector shows what was written');
  });
});

test('writeVoiceMode refuses anything outside the CLI enum', () => {
  withWrite({ model: 'opus', voice: { mode: 'hold' } }, (t) => {
    const before = t.bytes();
    for (const bad of ['loud', '', null, undefined, { evil: 1 }]) {
      const r = t.write(bad);
      assert.strictEqual(r.ok, false, String(bad));
      assert.match(r.error, /unknown voice mode/, String(bad));
    }
    assert.ok(before.equals(t.bytes()), 'a refused write leaves the file byte-for-byte alone');
  });
});

// OFF IS A FLAG, NOT A MODE, and that is the whole shape: the CLI's own `off`
// arm writes enabled:false and does NOT touch `voice.mode`. Normalising the mode
// here would diverge from the CLI over a file they share, and would lose which
// of tap/hold to return to.
test('writeVoiceMode off clears the enabled flag and LEAVES the mode alone', () => {
  withWrite({ model: 'opus', voice: { mode: 'hold', enabled: true, language: 'en' } }, (t) => {
    assert.deepStrictEqual(t.write('off'), { ok: true, mode: 'off', file: t.file });
    // The whole object: a spot check on `enabled` would read around a spread
    // that dropped `mode` or a sibling.
    assert.deepStrictEqual(t.read(), {
      model: 'opus',
      voiceEnabled: false,
      voice: { mode: 'hold', enabled: false, language: 'en' },
    });
  });
});

test('writeVoiceMode off round-trips through readVoiceMode as effective off', () => {
  withWrite({ voice: { mode: 'tap', enabled: true } }, (t) => {
    t.write('off');
    const r = readVoiceMode({ homeDir: t.home });
    assert.strictEqual(r.effective, 'off', 'the selector shows off');
    assert.strictEqual(r.mode, 'tap', 'and the mode to return to survived the write');
  });
});

// The never-used-voice box turning voice OFF: there is no existing mode to
// preserve, so the written object must carry none rather than inventing one.
test('writeVoiceMode off creates the file with no mode invented', () => {
  withWrite(null, (t) => {
    assert.strictEqual(fs.existsSync(t.file), false, 'ENTER: no file to start with');
    assert.strictEqual(t.write('off').ok, true);
    assert.deepStrictEqual(t.read(), { voiceEnabled: false, voice: { enabled: false } });
  });
});

// Off runs the same refusal gate as tap/hold. Pinned separately because the two
// arms are separate expressions after the guard: a refusal that only covered the
// mode-writing arm would leave this one clobbering an unparseable file.
test('writeVoiceMode off REFUSES an unparseable file, byte-identically', () => {
  withWrite('{"model":"opus",', (t) => {
    const before = t.bytes();
    const r = t.write('off');
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /syntax error/);
    assert.ok(before.equals(t.bytes()), 'the file the user was mid-edit on is untouched');
  });
});

test('writeVoiceMode creates the file when a box has never used voice', () => {
  withWrite(null, (t) => {
    assert.strictEqual(fs.existsSync(t.file), false, 'ENTER: no file to start with');
    assert.strictEqual(t.write('hold').ok, true);
    assert.deepStrictEqual(t.read(), {
      voiceEnabled: true, voice: { enabled: true, mode: 'hold' },
    });
  });
});

// THE DATA-LOSS CASE. An unparseable file is the user mid-hand-edit, and this
// is their GLOBAL CLI settings — merging onto `{}` there would replace every key
// they have with a two-key object, silently, on a verb they spoke from across
// the room. The CLI refuses the same case ("Check your settings file for syntax
// errors") instead of overwriting, so refusing is also what mirroring it means.
test('writeVoiceMode REFUSES an unparseable file and leaves it byte-identical', () => {
  const corrupt = [
    '{ not json',
    '{"model":"opus",',          // truncated mid-edit, the realistic shape
    '{"a":1,}',                  // trailing comma, the commonest hand-edit typo
  ];
  for (const body of corrupt) {
    withWrite(body, (t) => {
      const before = t.bytes();
      const r = t.write('tap');
      assert.strictEqual(r.ok, false, body);
      assert.match(r.error, /syntax error/, body);
      assert.match(r.error, /not changed/, body);
      assert.ok(before.equals(t.bytes()), `${body}: the file was rewritten`);
    });
  }
});

// Legible JSON that is not an object is a THIRD case, decided deliberately
// rather than let ride with the corrupt bodies: there is no key to merge into,
// so writing means discarding whatever the user does have. Same refusal, and
// the same byte-identity claim — one rule: we write only where our keys can be
// carried.
test('writeVoiceMode REFUSES legible JSON that is not an object, byte-identically', () => {
  for (const body of ['[]', 'null', '"a string"', '42']) {
    withWrite(body, (t) => {
      const before = t.bytes();
      const r = t.write('tap');
      assert.strictEqual(r.ok, false, body);
      assert.match(r.error, /not a JSON object/, body);
      assert.ok(before.equals(t.bytes()), `${body}: the file was rewritten`);
    });
  }
});

// An EMPTY file is on the write-succeeds side, with the absent file: there is
// demonstrably nothing in it to lose, so refusing would strand a box whose file
// was created empty with a verb that never works.
test('writeVoiceMode writes onto an empty or whitespace-only file', () => {
  for (const body of ['', '   \n\t ']) {
    withWrite(body, (t) => {
      assert.strictEqual(t.write('hold').ok, true, JSON.stringify(body));
      assert.deepStrictEqual(t.read(), {
        voiceEnabled: true, voice: { enabled: true, mode: 'hold' },
      }, JSON.stringify(body));
    });
  }
});

// A file we cannot READ is refused too, and for a sharper reason than symmetry:
// treating an unreadable file as absent would merge onto `{}` and clobber it the
// moment permissions allowed the write through.
test('writeVoiceMode refuses an unreadable file rather than treating it as absent', () => {
  withWrite({ model: 'opus', voice: { mode: 'hold' } }, (t) => {
    fs.chmodSync(t.file, 0o000);
    try {
      // Root ignores the mode bits, so a test running as root would read the
      // file happily and assert nothing. Skip rather than pass vacuously.
      let readable = true;
      try { fs.readFileSync(t.file); } catch { readable = false; }
      if (!readable) {
        const r = t.write('tap');
        assert.strictEqual(r.ok, false);
        assert.match(r.error, /could not be read/);
      }
    } finally {
      fs.chmodSync(t.file, 0o600);
    }
    assert.deepStrictEqual(t.read(), { model: 'opus', voice: { mode: 'hold' } },
      'the settings survived intact either way');
  });
});

test('writeVoiceMode leaves no temp file behind, and writes atomically', () => {
  withWrite({ voice: { mode: 'hold' } }, (t) => {
    t.write('tap');
    const strays = fs.readdirSync(path.join(t.home, '.claude')).filter((f) => f !== 'settings.json');
    assert.deepStrictEqual(strays, [], 'the atomic temp file was renamed, not orphaned');
  });
});

test('writeVoiceMode reports a write it could not perform rather than throwing', () => {
  withWrite({ voice: { mode: 'hold' } }, (t) => {
    const dir = path.join(t.home, '.claude');
    fs.chmodSync(dir, 0o500); // readable, not writable
    try {
      // Root ignores the mode bits and the write SUCCEEDS, which would fail this
      // assertion rather than skip it. Probe instead of assuming, same shape as
      // the unreadable-file case above.
      let blocked = false;
      try { fs.writeFileSync(path.join(dir, '.probe'), 'x'); fs.unlinkSync(path.join(dir, '.probe')); }
      catch { blocked = true; }
      if (blocked) {
        const r = t.write('tap');
        assert.strictEqual(r.ok, false);
        assert.ok(r.error && /EACCES|EPERM|EROFS/.test(r.error), `unexpected: ${r.error}`);
      }
    } finally {
      fs.chmodSync(dir, 0o700);
    }
  });
});

// A SYMLINKED settings.json is a dotfiles repo driving the setting. The write
// must land on the link's TARGET: renaming over the link replaces it with a
// regular file, after which the repo no longer drives anything and the next sync
// reverts the mode — silently, with an ok:true in hand.
//
// Both halves are load-bearing. Asserting only that the link survived passes for
// a mutant that skips the write entirely; asserting only the mode passes for one
// that clobbered the link. Neither alone pins the behaviour.
test('writeVoiceMode writes THROUGH a symlinked settings.json, not over it', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'clodex-voicesym-'));
  try {
    const store = path.join(home, 'dotfiles');
    fs.mkdirSync(store, { recursive: true });
    const real = path.join(store, 'settings.json');
    fs.writeFileSync(real, JSON.stringify({ model: 'opus', voice: { mode: 'hold', autoSubmit: true } }, null, 2));
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    const link = path.join(home, '.claude', 'settings.json');
    fs.symlinkSync(real, link);

    const r = writeVoiceMode('tap', { homeDir: home });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.file, link, 'the result names the path the caller asked about');

    assert.ok(fs.lstatSync(link).isSymbolicLink(), 'the symlink was replaced by a regular file');
    // The link surviving proves nothing on its own — the bytes must have moved.
    const written = JSON.parse(fs.readFileSync(real, 'utf8'));
    assert.strictEqual(written.voice.mode, 'tap', 'the repo file carries the new mode');
    assert.strictEqual(written.model, 'opus', 'and its unrelated keys survived');
    assert.strictEqual(written.voice.autoSubmit, true);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// Realpath on the file resolves a symlinked `.claude` without a second code
// path. Not the same hazard as a symlinked settings.json: a rename onto
// ~/.claude/settings.json traverses the directory link and replaces the inner
// regular file either way, so no link can be destroyed here. This guards that
// the dangling-link refusal does not fire on a resolvable directory link.
test('writeVoiceMode writes through a symlinked .claude directory', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'clodex-voicesymd-'));
  try {
    const store = path.join(home, 'dotfiles-claude');
    fs.mkdirSync(store, { recursive: true });
    fs.writeFileSync(path.join(store, 'settings.json'), JSON.stringify({ model: 'opus' }, null, 2));
    fs.symlinkSync(store, path.join(home, '.claude'));

    assert.strictEqual(writeVoiceMode('hold', { homeDir: home }).ok, true);
    assert.ok(fs.lstatSync(path.join(home, '.claude')).isSymbolicLink(), 'the directory link survived');
    const written = JSON.parse(fs.readFileSync(path.join(store, 'settings.json'), 'utf8'));
    assert.strictEqual(written.voice.mode, 'hold');
    assert.strictEqual(written.model, 'opus');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// A DANGLING link: readFileSync follows it and throws ENOENT, so the file reads
// as absent. Creating a regular file in its place would be the destructive
// fallback — the link is a structure the user put there deliberately and its
// target may simply be an unmounted drive, so this refuses instead.
test('writeVoiceMode refuses a dangling symlink rather than replacing it with a file', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'clodex-voicedang-'));
  try {
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    const link = path.join(home, '.claude', 'settings.json');
    fs.symlinkSync(path.join(home, 'nowhere', 'settings.json'), link);

    const r = writeVoiceMode('tap', { homeDir: home });
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /cannot be resolved/);
    assert.match(r.error, /not changed/);
    assert.ok(fs.lstatSync(link).isSymbolicLink(), 'the dangling link is still a link');
    assert.strictEqual(fs.existsSync(path.join(home, 'nowhere', 'settings.json')), false,
      'and nothing was created at its target');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
