// Speaking the agent's final reply aloud.
//
// Nobody here can HEAR the output, so nothing below claims the speech is
// pleasant; that test is the operator's. What is provable is the mechanism:
// which turns speak at all, what text reaches `say`, that the text is an argv
// element rather than a shell string, and that the two microphone interlocks
// fire in both directions.

const test = require('node:test');
const assert = require('node:assert');

const { speakable, isUnspeakableToken, SPEAK_MAX_CHARS } = require('../speakable');
const { createSpeaker, createVoiceCatalog, listVoices, DEFAULT_VOICE, SAY_BIN } = require('../speaker');
const { isTurnEndEntry } = require('../transcript');

// --- the discriminator ------------------------------------------------------

// The whole feature rides on this: an inter-tool flush must NOT read as a turn
// end, or the reply is narrated after every tool call. Each row carries its own
// literal expectation rather than re-deriving one from the rule under test.
test('isTurnEndEntry separates a finished turn from an inter-tool flush', () => {
  const rows = [
    ['claude end_turn', { type: 'assistant', message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'hi' }] } }, true],
    ['claude tool_use', { type: 'assistant', message: { stop_reason: 'tool_use', content: [{ type: 'text', text: 'hi' }] } }, false],
    ['claude max_tokens', { type: 'assistant', message: { stop_reason: 'max_tokens', content: [] } }, false],
    ['claude stop_reason absent', { type: 'assistant', message: { content: [] } }, false],
    ['claude null stop_reason', { type: 'assistant', message: { stop_reason: null } }, false],
    ['a user entry', { type: 'user', message: { content: [{ type: 'tool_result' }] } }, false],
    ['subagent end_turn', { type: 'assistant', isSidechain: true, message: { stop_reason: 'end_turn' } }, false],
    ['meta end_turn', { type: 'assistant', isMeta: true, message: { stop_reason: 'end_turn' } }, false],
    ['codex task_complete', { type: 'event_msg', payload: { type: 'task_complete' } }, true],
    ['codex agent_message', { type: 'event_msg', payload: { type: 'agent_message', message: 'hi' } }, false],
    ['codex token_count', { type: 'event_msg', payload: { type: 'token_count' } }, false],
    ['garbage', {}, false],
    ['null', null, false],
  ];
  for (const [label, obj, want] of rows) {
    assert.strictEqual(isTurnEndEntry(obj), want, `${label}: expected ${want}`);
  }
});

// The renderer activity seam is NOT the discriminator, and this pins why rather
// than trusting the doc — which claimed the opposite and was wrong. The value
// session-manager passes for a jsonl session is `state === 'idle'`, so every
// flush that ends 'thinking' reports a turn end.
test('the renderer activity seam cannot answer the turn-end question', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'session-manager.js'), 'utf-8');
  assert.ok(
    src.includes("(state) => this._emitActivity(name, state, state === 'idle')"),
    'the jsonl watcher still passes a bare idle as turnEnd — if this line changed, '
    + 're-derive whether _maybeSpeak may read that seam',
  );
  assert.ok(
    src.includes('this._maybeSpeak(t.agent, t.text, !!(t.stop && t.stop.is_turn))'),
    'the wire junction must speak off stop.is_turn, not off an activity state',
  );
});

// --- what reaches `say` -----------------------------------------------------

test('speakable drops what cannot be spoken', () => {
  const rows = [
    ['a fenced block goes whole', 'Before.\n```js\nconst x = 1;\n```\nAfter.', 'Before. After.'],
    ['an unclosed fence takes the tail', 'Before.\n```\nraw code\nmore', 'Before.'],
    ['a table row is data', '| a | b |\n|---|---|\nAfter.', 'After.'],
    ['an absolute path', 'Edited /Users/x/y.js now.', 'Edited now.'],
    ['a relative path', 'Edited ./src/a.js now.', 'Edited now.'],
    ['a bare filename', 'See renderer.js for it.', 'See for it.'],
    ['a url', 'Read https://example.com/a now.', 'Read now.'],
    ['link text survives its target', 'Read [the docs](https://x.com/y).', 'Read the docs.'],
    ['backticks go, path inside goes', 'In `renderer/renderer.js` today.', 'In today.'],
    ['bullets become sentences', '- one\n- two', 'one. two.'],
    ['a numbered list becomes sentences', '1. first\n2. second', 'first. second.'],
    ['a bullet that is already punctuated gains nothing', '- one!\n- two?', 'one! two?'],
    ['headings lose their hashes', '## Summary\n\nDone.', 'Summary. Done.'],
    ['bold and italic lose their marks', 'It is **very** *odd*.', 'It is very odd.'],
    ['a version number is not a filename', 'Now at 0.16 today.', 'Now at 0.16 today.'],
    ['prose slashes survive', 'Use and/or TCP/IP here.', 'Use and/or TCP/IP here.'],
  ];
  for (const [label, input, want] of rows) {
    assert.strictEqual(speakable(input), want, label);
  }
});

// An intent body is greedy, so a dm's body would otherwise be narrated in full —
// a message addressed to another agent, read aloud to the room.
test('speakable never reads an intent or its body', () => {
  const out = speakable('I will tell the lead.\n\n[agent:dm clodex]\nthe secret body\nand more\n[agent:end]\n\nDone.');
  assert.strictEqual(out, 'I will tell the lead. Done.');
  assert.ok(!out.includes('secret'), 'the dm body must not be spoken');
});

test('speakable yields nothing for a turn with nothing to say', () => {
  for (const empty of ['', null, undefined, 42, '```\ncode only\n```', '[agent:dm x]\nbody\n[agent:end]', '   \n\n  ']) {
    assert.strictEqual(speakable(empty), '', `expected silence for ${JSON.stringify(empty)}`);
  }
});

test('speakable bounds the utterance and prefers a sentence boundary', () => {
  const long = `${'One sentence here. '.repeat(60)}`;
  const out = speakable(long);
  assert.ok(out.length <= SPEAK_MAX_CHARS, `expected <= ${SPEAK_MAX_CHARS}, got ${out.length}`);
  assert.ok(out.endsWith('.'), `expected a sentence end, got ${JSON.stringify(out.slice(-20))}`);

  // A single sentence longer than the ceiling must still be truncated rather
  // than dropped: falling back to a word boundary is what keeps it audible.
  const oneLong = `${'word '.repeat(200)}end.`;
  const cut = speakable(oneLong);
  assert.ok(cut.length <= SPEAK_MAX_CHARS && cut.length > 0, 'a long single sentence is cut, not dropped');
});

test('isUnspeakableToken is conservative about a bare slash', () => {
  for (const yes of ['/etc/passwd', '~/notes.md', './a.js', 'https://x.com', 'a/b/c.json', 'renderer.js']) {
    assert.strictEqual(isUnspeakableToken(yes), true, `${yes} should be dropped`);
  }
  for (const no of ['and/or', 'TCP/IP', 'hello', '3.14', 'Mr.', 'e.g']) {
    assert.strictEqual(isUnspeakableToken(no), false, `${no} should be spoken`);
  }
});

// --- the process ------------------------------------------------------------

// The one hard security constraint. Model text reaches this call, so a shell
// string would be a command-injection hole: the payload must arrive as an argv
// ELEMENT, intact and uninterpreted.
test('say is spawned with the text as an argument, never a shell string', () => {
  const calls = [];
  const sp = createSpeaker({ execFileImpl: (bin, args, cb) => { calls.push({ bin, args, cb }); return { kill() {} }; } });
  const nasty = '$(rm -rf /) `whoami` && echo pwned; drop | tee';
  sp.speak(nasty);

  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].bin, SAY_BIN);
  const { args } = calls[0];
  // The payload is one element, byte-identical to what was handed in.
  assert.strictEqual(args[args.length - 1], nasty);
  assert.deepStrictEqual(args, ['-v', DEFAULT_VOICE, '--', nasty]);
  // No element is a joined command line — that shape is what a shell would parse.
  assert.ok(!args.some((a) => a !== nasty && /[;&|]/.test(a)), 'no arg may carry shell metacharacters');
});

// `--` is what stops a reply opening with a hyphen from being read as a flag.
test('a reply starting with a hyphen is text, not a flag', () => {
  const calls = [];
  const sp = createSpeaker({ execFileImpl: (bin, args, cb) => { calls.push(args); return { kill() {} }; } });
  sp.speak('-v Zarvox is not a voice here');
  const args = calls[0];
  assert.strictEqual(args[args.length - 2], '--');
  assert.strictEqual(args[args.length - 1], '-v Zarvox is not a voice here');
});

test('one utterance at a time — a second speak replaces the first', () => {
  const killed = [];
  let n = 0;
  const sp = createSpeaker({ execFileImpl: () => { const id = ++n; return { kill() { killed.push(id); } }; } });
  sp.speak('first');
  assert.strictEqual(sp.isSpeaking(), true);
  sp.speak('second');
  assert.deepStrictEqual(killed, [1], 'the first child is killed, not left to overlap');
  assert.strictEqual(sp.isSpeaking(), true);
});

test('stop is idempotent and clears the speaking state', () => {
  let killed = 0;
  const sp = createSpeaker({ execFileImpl: () => ({ kill() { killed += 1; } }) });
  sp.speak('hello');
  assert.strictEqual(sp.stop(), true);
  assert.strictEqual(sp.isSpeaking(), false);
  assert.strictEqual(sp.stop(), false, 'nothing to stop reports false');
  assert.strictEqual(killed, 1);
});

// The operator's actual question: he taps the mic while a narration is playing.
// Option (a) — kill it. Pinned as a NAMED behaviour, so a refactor that moved
// the call out of noteVoiceRecording fails here rather than going quiet.
test('interruptForRecorder stops a narration in progress', () => {
  let killed = 0;
  const sp = createSpeaker({ execFileImpl: () => ({ kill() { killed += 1; } }) });
  sp.speak('a long narration');
  assert.strictEqual(sp.interruptForRecorder(), true);
  assert.strictEqual(killed, 1);
  assert.strictEqual(sp.isSpeaking(), false);
  assert.strictEqual(sp.interruptForRecorder(), false, 'silence is not interrupted');
});

test('a speak that throws leaves no phantom child', () => {
  const sp = createSpeaker({ execFileImpl: () => { throw new Error('ENOENT'); } });
  assert.strictEqual(sp.speak('hello'), false);
  assert.strictEqual(sp.isSpeaking(), false);
});

test('an exit callback never nulls out a newer child', () => {
  const cbs = [];
  const sp = createSpeaker({ execFileImpl: (_b, _a, cb) => { cbs.push(cb); return { kill() {} }; } });
  sp.speak('first');
  sp.speak('second');
  // The FIRST child's exit lands after the second started. If it cleared the
  // field, the live narration would be unstoppable and isSpeaking would lie.
  cbs[0]();
  assert.strictEqual(sp.isSpeaking(), true, "the first child's exit must not disown the second");
});

// --- voices -----------------------------------------------------------------

test('listVoices parses the say listing and keeps names containing spaces', () => {
  const fixture = [
    'Albert              en_US    # Hello! My name is Albert.',
    'Daniel              en_GB    # Hello! My name is Daniel.',
    'Eddy (English (UK)) en_GB    # Hello! My name is Eddy.',
    'Alice               it_IT    # Ciao! Mi chiamo Alice.',
    '',
  ].join('\n');
  const got = listVoices({ execFileSyncImpl: () => fixture });
  assert.deepStrictEqual(got, [
    { name: 'Albert', locale: 'en_US' },
    { name: 'Daniel', locale: 'en_GB' },
    { name: 'Eddy (English (UK))', locale: 'en_GB' },
  ], 'non-English locales are filtered; a parenthesised name survives intact');
});

test('listVoices degrades to an empty list rather than throwing', () => {
  assert.deepStrictEqual(listVoices({ execFileSyncImpl: () => { throw new Error('no say'); } }), []);
});

// An uninstalled voice must still speak. `say` substitutes the system voice and
// exits 0 for an unknown name (verified on the box), so the failure mode to
// avoid is US refusing to spawn — never the reverse.
test('an unknown voice is still passed through and still speaks', () => {
  const calls = [];
  const sp = createSpeaker({ execFileImpl: (_b, args) => { calls.push(args); return { kill() {} }; } });
  assert.strictEqual(sp.speak('hello', { voice: 'NoSuchVoiceXYZ' }), true);
  assert.deepStrictEqual(calls[0], ['-v', 'NoSuchVoiceXYZ', '--', 'hello']);
});

test('a blank voice omits the flag rather than sending an empty one', () => {
  const calls = [];
  const sp = createSpeaker({ execFileImpl: (_b, args) => { calls.push(args); return { kill() {} }; } });
  sp.speak('hello', { voice: '' });
  assert.deepStrictEqual(calls[0], ['--', 'hello'], 'an empty -v argument would be a malformed command');
});

// The enumeration costs ~650ms and settings:get is called on every popover open,
// so a synchronous read there would freeze the main process for two thirds of a
// second per open. These pin that list() neither blocks nor stampedes.
test('the voice catalog never blocks a reader', () => {
  let spawned = 0;
  const cat = createVoiceCatalog({ execFileImpl: (_b, _a, _o, cb) => { spawned += 1; return cb; } });
  assert.deepStrictEqual(cat.list(), [], 'a cold read answers empty rather than waiting');
  assert.strictEqual(spawned, 1, 'and starts exactly one warm');
});

test('concurrent reads do not stampede the enumeration', () => {
  const cbs = [];
  const cat = createVoiceCatalog({ execFileImpl: (_b, _a, _o, cb) => { cbs.push(cb); } });
  cat.list(); cat.list(); cat.list();
  assert.strictEqual(cbs.length, 1, 'a burst of settings:get opens must spawn one `say`, not three');

  cbs[0](null, 'Daniel              en_GB    # Hello!\n');
  assert.deepStrictEqual(cat.list(), [{ name: 'Daniel', locale: 'en_GB' }]);
});

test('a failed enumeration keeps the last good list rather than blanking it', () => {
  const cbs = [];
  let t = 1000;
  const cat = createVoiceCatalog({
    execFileImpl: (_b, _a, _o, cb) => { cbs.push(cb); },
    ttlMs: 10,
    now: () => t,
  });
  cat.list();
  cbs[0](null, 'Daniel              en_GB    # Hello!\n');
  assert.strictEqual(cat.list().length, 1);

  t += 100;                       // past the TTL, so the next read re-warms
  cat.list();
  assert.strictEqual(cbs.length, 2, 'the TTL expiry re-warms, so an installed voice appears without a restart');
  cbs[1](new Error('say vanished'));
  assert.deepStrictEqual(cat.list(), [{ name: 'Daniel', locale: 'en_GB' }],
    'a failed refresh must not empty the picker');
});

// Every existing fixture builds SessionManager without a speaker, and speech is
// observer-grade: a host that wires none must get silence, never a throw on the
// turn path. Pinned on the SOURCE because constructing the manager here would
// need the whole dependency graph.
test('a manager built without a speaker still handles a turn', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'session-manager.js'), 'utf-8');
  assert.ok(/const speaker = deps\.speaker \|\| \{/.test(src),
    'the speaker dep must fall back to a silent stub, not arrive undefined');
  assert.ok(!/^\s*speaker,$/m.test(src),
    'and must not ALSO be destructured, which would shadow the fallback with undefined');
});

// --- the settings -----------------------------------------------------------

test('the setting defaults OFF and to the clearest voice', () => {
  const { DEFAULT_UI_SETTINGS } = requireDefaults();
  assert.strictEqual(DEFAULT_UI_SETTINGS.speakReplies, false, 'an experiment ships off');
  assert.strictEqual(DEFAULT_UI_SETTINGS.speakVoice, DEFAULT_VOICE);
});

function requireDefaults() {
  // stores.js is a factory over electron paths; the defaults table is a module
  // constant, read here without constructing a store.
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'stores.js'), 'utf-8');
  const speakReplies = /^\s*speakReplies:\s*(\w+),/m.exec(src);
  const speakVoice = /^\s*speakVoice:\s*'([^']+)',/m.exec(src);
  assert.ok(speakReplies && speakVoice, 'the defaults must be declared in DEFAULT_UI_SETTINGS');
  return { DEFAULT_UI_SETTINGS: { speakReplies: speakReplies[1] === 'true', speakVoice: speakVoice[1] } };
}
