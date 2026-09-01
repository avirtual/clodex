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
const {
  createSpeaker, createVoiceCatalog, listVoices,
  DEFAULT_VOICE, DEFAULT_RATE, MIN_RATE, MAX_RATE, SAY_BIN,
} = require('../speaker');
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

// THE WATCHER SEAM — the pin that matters, and the one whose absence let a dead
// path ship green. A unit assertion on `isTurnEndEntry` says what the function
// returns; it cannot say whether the value ever REACHES `onText`. The Codex
// branch was correct as a function and unreachable as a feature, because
// `isTurnEndEntry` was only ever consulted for entries carrying text and
// `task_complete` carries none.
//
// So these drive real entry sequences through the real line handler and assert
// the `{ turnEnd }` that actually arrives at the callback.
function runWatcher(entries) {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { createJsonlWatcher } = require('../jsonl-watcher');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clodex-watcher-'));
  const file = path.join(dir, 'transcript.jsonl');
  fs.writeFileSync(file, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');

  const { JsonlWatcher } = createJsonlWatcher({ REGISTRY_DIR: dir });
  const seen = [];
  const w = new JsonlWatcher('seat', (text, touches, meta) => seen.push({ text, meta }));
  // Drive the reader directly against the fixture: _poll would resolve the
  // registry symlink and start at EOF, which is right in production and would
  // read nothing here.
  w._fd = fs.openSync(file, 'r');
  w._position = 0;
  w._readLines();
  // The terminator may be the last line, leaving text pending exactly as a live
  // transcript does between turns; stop() performs the same final flush.
  w.stop();
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  return seen;
}

test('a Claude turn reaches onText with turnEnd true only at end_turn', () => {
  const seen = runWatcher([
    { type: 'assistant', requestId: 'r1', message: { stop_reason: 'tool_use', content: [{ type: 'text', text: 'working on it' }] } },
    { type: 'user', message: { content: [{ type: 'tool_result' }] } },
    { type: 'assistant', requestId: 'r2', message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'all done' }] } },
  ]);
  assert.deepStrictEqual(
    seen.map((s) => [s.text, s.meta.turnEnd]),
    [['working on it', false], ['all done', true]],
    'the inter-tool flush must arrive false and only the end_turn text true',
  );
});

// The exact four-entry rollout shape, in order, from real Codex sessions. Before
// the fix `token_count` flushed the text away carrying false, and
// `task_complete` arrived with nothing pending — so no Codex reply could ever
// be spoken while the unit test asserted otherwise and stayed green.
test('a Codex turn reaches onText with turnEnd true at task_complete', () => {
  const seen = runWatcher([
    { type: 'event_msg', payload: { type: 'agent_message', message: 'the codex reply' } },
    { type: 'response_item', payload: { type: 'reasoning' } },
    { type: 'event_msg', payload: { type: 'token_count' } },
    { type: 'event_msg', payload: { type: 'task_complete' } },
  ]);
  assert.deepStrictEqual(
    seen.map((s) => [s.text, s.meta.turnEnd]),
    [['the codex reply', true]],
    'the reply must arrive exactly once, flagged as ending the turn',
  );
});

// THE SHAPE THAT MADE THE LOSS GREEN. The round-2 Codex fixture had no
// `function_call_output` after the reply, so the one interleaving that drops
// text was never exercised. Codex entries carry no requestId and no payload.id,
// so every rid is '' — an equality test reads a reply and a later tool output as
// the same turn and OVERWRITES the reply. What is discarded is the intent scan's
// input, which this repo keeps at-least-once on purpose.
//
// This shape occurs ~7859 times across the corpus; it is the common turn, not
// an edge case.
test('a Codex reply survives a fast tool call in the same turn', () => {
  const seen = runWatcher([
    { type: 'event_msg', payload: { type: 'agent_message', message: '[agent:dm clodex] first' } },
    { type: 'response_item', payload: { type: 'message' } },
    { type: 'event_msg', payload: { type: 'token_count' } },
    { type: 'response_item', payload: { type: 'function_call_output', output: 'Process exited with code 0' } },
    { type: 'event_msg', payload: { type: 'agent_message', message: 'final' } },
    { type: 'event_msg', payload: { type: 'token_count' } },
    { type: 'event_msg', payload: { type: 'task_complete' } },
  ]);
  assert.deepStrictEqual(
    seen.map((x) => [x.text, x.meta.turnEnd]),
    [
      ['[agent:dm clodex] first', false],
      ['Process exited with code 0', false],
      ['final', true],
    ],
    'the mid-turn reply must reach onText — dropping it loses an intent silently',
  );
});

// The one scope rule the operator stated twice. A Codex turn can end right after
// a tool output (an interrupted turn does), and flagging whatever is pending
// would narrate a command dump as if it were the reply.
test('a turn ending on a tool output is not spoken', () => {
  const seen = runWatcher([
    { type: 'response_item', payload: { type: 'function_call_output', output: 'Command: /bin/zsh -lc ls\nProcess exited with code 0' } },
    { type: 'event_msg', payload: { type: 'task_complete' } },
  ]);
  assert.strictEqual(seen.length, 1, 'the tool output still reaches the intent scan');
  assert.strictEqual(seen[0].meta.turnEnd, false,
    'but it must never be flagged as the reply that ends the turn');
});

test('a Codex turn still mid-flight does not report a turn end', () => {
  const seen = runWatcher([
    { type: 'event_msg', payload: { type: 'agent_message', message: 'thinking aloud' } },
    { type: 'event_msg', payload: { type: 'token_count' } },
  ]);
  assert.deepStrictEqual(
    seen.map((s) => [s.text, s.meta.turnEnd]),
    [['thinking aloud', false]],
    'telemetry alone must not promote a mid-turn flush into a turn end',
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
  assert.deepStrictEqual(args, ['-v', DEFAULT_VOICE, '-r', String(DEFAULT_RATE), '--', nasty]);
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
  assert.deepStrictEqual(calls[0], ['-v', 'NoSuchVoiceXYZ', '-r', String(DEFAULT_RATE), '--', 'hello']);
});

test('a blank voice omits the flag rather than sending an empty one', () => {
  const calls = [];
  const sp = createSpeaker({ execFileImpl: (_b, args) => { calls.push(args); return { kill() {} }; } });
  sp.speak('hello', { voice: '' });
  assert.deepStrictEqual(calls[0], ['-r', String(DEFAULT_RATE), '--', 'hello'],
    'an empty -v argument would be a malformed command');
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

// Building the engine must spawn nothing. An eager warm here forked a real
// `say -v '?'` in every test that constructs an engine, and those children
// outlived the test process that spawned them — orphaned to pid 1, invisible to
// a green suite. The catalog warms on first READ, which only a live surface does.
test('constructing the engine does not spawn the voice enumeration', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'engine.js'), 'utf-8');
  assert.ok(src.includes('createVoiceCatalog()'), 'the catalog is still constructed');
  assert.ok(!/voiceCatalog\.refresh\(\)/.test(src),
    'engine.js must not warm the catalog eagerly — that spawns `say` in every '
    + 'engine-building test and orphans it');
});

// THE BOX-WIDE INTERLOCK, through the real SessionManager wiring.
//
// The renderer only ever reports the ACTIVE seat's recorder, so any other seat's
// own stamp is undefined forever and a per-seat read would pass exactly while he
// is dictating elsewhere. The microphone and the speaker are both box-wide, and
// this gate reads box-wide with them.
//
// Reaching that read now takes a seat that has already cleared the holder gate,
// which is why the recorder tests below hand one the microphone first: a seat
// silenced for not holding it never evaluates the stamp at all, and the
// assertion would hold for the wrong reason.
//
// `speakReplies` is a PARAMETER, not a constant, and that is the whole reason
// this helper exists in this shape: with it hardcoded true, the gate in
// _maybeSpeak could be deleted outright and the suite stayed green — an unpinned
// guard is the only thing the "default OFF" requirement rests on.
function bootSpeakingManager({ speakReplies = true, speakRate } = {}) {
  const { createSessionManager } = require('../session-manager');
  const spoken = [];
  const opts = [];
  const SessionManager = createSessionManager({
    INJECT_SPEAKING_STALE_MS: 3000,
    log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    getUiSettings: () => ({ get: () => ({ speakReplies, speakVoice: 'Daniel', speakRate }) }),
    speaker: {
      speak: (text, o) => { spoken.push(text); opts.push(o); return true; },
      stop: () => false, interruptForRecorder: () => false, isSpeaking: () => false,
    },
  });
  const m = new SessionManager();
  m._broadcast = () => {};
  const mk = (name) => ({ name, agentType: 'claude', _dead: false });
  m.sessions = new Map([['seatA', mk('seatA')], ['seatB', mk('seatB')]]);
  return { m, spoken, opts };
}

// Hand a seat the microphone by the REAL entry points. The two box-wide facts
// are what _setMicTarget demands, and reaching past them by assigning
// `_micTarget` would let a rewrite that moves the authority elsewhere keep every
// pin below green.
function giveMic(m, name) {
  m.noteAppFocused(true);
  m.noteFocusedSession(name, { isFocused: () => true });
}

test('speakReplies false speaks NOTHING, which is what default-off rests on', () => {
  const { m, spoken } = bootSpeakingManager({ speakReplies: false });
  // Otherwise the seat is silent for want of the microphone and this asserts
  // nothing about the setting.
  giveMic(m, 'seatB');
  m._maybeSpeak('seatB', 'this must stay silent', true);
  assert.deepStrictEqual(spoken, [],
    'the setting is the only guard between a fresh install and a talking box');
});

test('the operator-chosen rate reaches the speaker, per turn', () => {
  const { m, opts } = bootSpeakingManager({ speakRate: 210 });
  giveMic(m, 'seatB');
  m._maybeSpeak('seatB', 'read this at the chosen speed', true);
  assert.strictEqual(opts.length, 1);
  assert.strictEqual(opts[0].rate, 210, 'a rate read but never passed is a setting that does nothing');
  assert.strictEqual(opts[0].voice, 'Daniel');
});

test('the recorder on ONE seat silences a turn ending on ANOTHER', () => {
  const { m, spoken } = bootSpeakingManager();
  // seatB holds the microphone, so it clears the holder gate and the recorder
  // stamp is the only thing left to silence it. Without this the seat is mute
  // either way and the box-wide read below is asserted vacuously.
  giveMic(m, 'seatB');
  // The renderer reports the seat he is looking at — by its real entry point.
  m.noteVoiceRecording('seatA');
  m._maybeSpeak('seatB', 'a background seat just finished', true);
  assert.deepStrictEqual(spoken, [],
    'a background turn must not narrate into a microphone lit on another seat');
});

test('with no recorder anywhere, the seat holding the microphone speaks', () => {
  const { m, spoken } = bootSpeakingManager();
  giveMic(m, 'seatB');
  assert.strictEqual(m.micTarget(), 'seatB', 'ENTER: the holder gate is satisfied');
  m._maybeSpeak('seatB', 'all quiet here', true);
  assert.deepStrictEqual(spoken, ['all quiet here'],
    'absent evidence reads as not recording — doubt must speak, never wedge');
});

// THE CHORUS. speak() kills the previous utterance, so an ungated background
// seat does not merely add a voice — it truncates the holder's reply too.
test('a seat that does not hold the microphone is silent while another holds it', () => {
  const { m, spoken } = bootSpeakingManager();
  giveMic(m, 'seatA');
  assert.strictEqual(m.micTarget(), 'seatA', 'ENTER: someone else holds it');
  m._maybeSpeak('seatB', 'a background seat narrating over the holder', true);
  assert.deepStrictEqual(spoken, [], 'only the seat holding control may speak');
  m._maybeSpeak('seatA', 'the holder speaks', true);
  assert.deepStrictEqual(spoken, ['the holder speaks'],
    'and the holder still does — a gate that silences everyone is the other bug');
});

// _micTarget moves only while Clodex is frontmost, so a strict read of it alone
// would make the feature dead on a box he alt-tabbed away from before naming a
// seat. _focusedSession is the seat he is LOOKING at and updates regardless.
test('with no microphone target, the seat he is looking at speaks', () => {
  const { m, spoken } = bootSpeakingManager();
  m.noteFocusedSession('seatB', { isFocused: () => true });
  assert.strictEqual(m.micTarget(), null, 'ENTER: the app was never frontmost, so nothing targeted');
  assert.strictEqual(m._focusedSession, 'seatB');
  m._maybeSpeak('seatA', 'not the seat he is looking at', true);
  assert.deepStrictEqual(spoken, [], 'the fallback is a fallback, not an open door');
  m._maybeSpeak('seatB', 'the seat he is looking at', true);
  assert.deepStrictEqual(spoken, ['the seat he is looking at']);
});

test('with NOBODY holding control, nobody speaks', () => {
  const { m, spoken } = bootSpeakingManager();
  assert.strictEqual(m.micTarget(), null);
  assert.strictEqual(m._focusedSession, null, 'ENTER: both records are empty');
  m._maybeSpeak('seatA', 'nobody asked for this', true);
  m._maybeSpeak('seatB', 'nor this', true);
  assert.deepStrictEqual(spoken, []);
});

// The two records must not be collapsed into one. An external tap moves the
// microphone and deliberately does NOT move the focus record, so a "simplifying"
// merge silently re-points background tap routing at the last seat he named.
test('the microphone holder outranks the focused seat when they differ', () => {
  const { m, spoken } = bootSpeakingManager();
  giveMic(m, 'seatA');
  // A background window reporting its own active seat: routing follows, the
  // microphone does not.
  m.noteFocusedSession('seatB', { isFocused: () => false });
  assert.strictEqual(m.micTarget(), 'seatA');
  assert.strictEqual(m._focusedSession, 'seatB', 'ENTER: the two records genuinely disagree');
  m._maybeSpeak('seatB', 'the focused seat is not the holder', true);
  assert.deepStrictEqual(spoken, [], 'the fallback applies only when nothing holds the microphone');
  m._maybeSpeak('seatA', 'the holder still speaks', true);
  assert.deepStrictEqual(spoken, ['the holder still speaks']);
});

test('the per-seat recorder field survives alongside the box-wide one', () => {
  const { m } = bootSpeakingManager();
  m.noteVoiceRecording('seatA');
  assert.ok(m.sessions.get('seatA').lastVoiceRecordingTs > 0,
    'the inject gate reads the per-seat field and is correctly per-seat — it must not be replaced');
  assert.ok(m._lastVoiceRecordingTs > 0, 'and the box-wide stamp is written alongside it');
  assert.strictEqual(m.sessions.get('seatB').lastVoiceRecordingTs, undefined,
    'stamping one seat must not stamp another — that is what makes the per-seat read useless for audio');
});

// --- the settings -----------------------------------------------------------

test('the setting defaults OFF and to the clearest voice', () => {
  const { DEFAULT_UI_SETTINGS } = requireDefaults();
  assert.strictEqual(DEFAULT_UI_SETTINGS.speakReplies, false, 'an experiment ships off');
  assert.strictEqual(DEFAULT_UI_SETTINGS.speakVoice, DEFAULT_VOICE);
});

// --- the rate ---------------------------------------------------------------

test('the rate rides as its own argv pair, and the text stays last', () => {
  const calls = [];
  const sp = createSpeaker({ execFileImpl: (_b, args) => { calls.push(args); return { kill() {} }; } });
  sp.speak('hello', { voice: 'Daniel', rate: 240 });
  assert.deepStrictEqual(calls[0], ['-v', 'Daniel', '-r', '240', '--', 'hello']);
});

// `say -r 5` is accepted and SPOKEN at 5 wpm — a box that looks wedged with no
// error anywhere. Each row carries its own literal rather than re-deriving the
// bound from the rule under test.
test('a rate outside the sane band is dropped, not passed through', () => {
  for (const [label, rate] of [
    ['zero', 0], ['negative', -50], ['absurdly slow', 5], ['absurdly fast', 5000],
    ['not a number', 'fast'], ['null', null], ['NaN', NaN], ['Infinity', Infinity],
  ]) {
    const calls = [];
    const sp = createSpeaker({ execFileImpl: (_b, args) => { calls.push(args); return { kill() {} }; } });
    sp.speak('hello', { voice: 'Daniel', rate });
    assert.deepStrictEqual(calls[0], ['-v', 'Daniel', '--', 'hello'], label);
  }
});

test('the boundary rates are IN, and one step past each is out', () => {
  const argsFor = (rate) => {
    const calls = [];
    const sp = createSpeaker({ execFileImpl: (_b, a) => { calls.push(a); return { kill() {} }; } });
    sp.speak('x', { voice: '', rate });
    return calls[0];
  };
  assert.deepStrictEqual(argsFor(80), ['-r', '80', '--', 'x']);
  assert.deepStrictEqual(argsFor(400), ['-r', '400', '--', 'x']);
  assert.deepStrictEqual(argsFor(79), ['--', 'x']);
  assert.deepStrictEqual(argsFor(401), ['--', 'x']);
});

test('the operator listened to three rates and picked 210', () => {
  assert.strictEqual(DEFAULT_RATE, 210);
  const { DEFAULT_UI_SETTINGS } = requireDefaults();
  assert.strictEqual(DEFAULT_UI_SETTINGS.speakRate, 210,
    'the store default and the speaker default must not be able to disagree');
});

// The band is written twice — stores.js cannot import speaker.js, since it is
// loaded before whenReady and must stay off the process side. Nothing held the
// pair, and the drift is SILENT in the direction that matters: the store admits
// a rate `speak()` then drops, so the operator hears `say`'s 175 with the
// picker showing what he chose.
test('the store admits exactly the band the speaker will honour', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'stores.js'), 'utf-8');
  const guard = /raw >= (\d+) && raw <= (\d+)/.exec(src);
  assert.ok(guard, 'sanitizeSpeakRate must still express the band as literals');
  assert.strictEqual(Number(guard[1]), MIN_RATE, 'store floor === speaker MIN_RATE');
  assert.strictEqual(Number(guard[2]), MAX_RATE, 'store ceiling === speaker MAX_RATE');
});

// The popover's copy of the default is the one that would LIE: the two
// main-process copies are pinned against each other above, and this one is what
// the operator sees when a read produces no rate.
test('every surface offering a rate agrees on the default', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const pop = fs.readFileSync(
    path.join(__dirname, '..', 'renderer', 'popovers', 'voice-popover.js'), 'utf-8');
  const fallback = /const DEFAULT_SPEAK_RATE = (\d+);/.exec(pop);
  assert.ok(fallback, 'the popover fallback must be a named constant, not inlined');
  assert.strictEqual(Number(fallback[1]), DEFAULT_RATE,
    'the popover would show a default the speaker does not use');
  // And the chosen rate must actually be OFFERED, or picking it back after
  // switching away is impossible from the surface that owns the choice.
  const listed = [...pop.matchAll(/\{ rate: (\d+), label:/g)].map((m) => Number(m[1]));
  assert.ok(listed.includes(DEFAULT_RATE), `the picker must offer ${DEFAULT_RATE}: got ${listed}`);

  const html = fs.readFileSync(
    path.join(__dirname, '..', 'renderer', 'index.html'), 'utf-8');
  const opts = [...html.matchAll(/<option value="(\d+)">\d+ &mdash;/g)].map((m) => Number(m[1]));
  assert.deepStrictEqual(opts, listed,
    'Settings and the popover must offer the same rates, in the same order');
});

// --- the busy signal --------------------------------------------------------
//
// The renderer cannot see this process, so these two edges are the ENTIRE
// mechanism by which the turn-end re-arm knows to wait. `say` blocks until
// playback completes (measured 5.2s for a ~5s sentence), so the exit callback IS
// the end of audio — which is why no consumer may substitute a timer for it.

test('onBusy reports the start and the end of playback, and only on a change', () => {
  const seen = [];
  let exit = null;
  const sp = createSpeaker({
    execFileImpl: (_b, _a, cb) => { exit = cb; return { kill() {} }; },
    onBusy: (b) => seen.push(b),
  });
  sp.speak('a reply');
  assert.deepStrictEqual(seen, [true]);
  // A second utterance replaces the first WITHOUT a false in between: the
  // speaker never went quiet, and a spurious false would release a waiting
  // re-arm into a live narration.
  sp.speak('a newer reply');
  assert.deepStrictEqual(seen, [true], 'replacing an utterance is not a gap in playback');
  exit();
  assert.deepStrictEqual(seen, [true, false]);
});

test('a killed narration reports false at the kill, not a tick later', () => {
  // stop() is what interruptForRecorder and every teardown path calls. A
  // consumer waiting on the false edge would otherwise sit out the gap until
  // the exit callback landed.
  const seen = [];
  const sp = createSpeaker({ execFileImpl: () => ({ kill() {} }), onBusy: (b) => seen.push(b) });
  sp.speak('a long narration');
  sp.interruptForRecorder();
  assert.deepStrictEqual(seen, [true, false]);
});

test('a speak that throws does not leave the box marked busy forever', () => {
  const seen = [];
  const sp = createSpeaker({ execFileImpl: () => { throw new Error('ENOENT'); }, onBusy: (b) => seen.push(b) });
  assert.strictEqual(sp.speak('hello'), false);
  assert.deepStrictEqual(seen, [], 'never announced busy, so there is nothing to release');
  assert.strictEqual(sp.isSpeaking(), false);
});

test('a throwing onBusy cannot take down speak or stop', () => {
  const sp = createSpeaker({
    execFileImpl: () => ({ kill() {} }),
    onBusy: () => { throw new Error('a window went away'); },
  });
  assert.strictEqual(sp.speak('hello'), true);
  assert.strictEqual(sp.stop(), true);
});

test('a speaker with no listener still works — the signal is optional', () => {
  const sp = createSpeaker({ execFileImpl: () => ({ kill() {} }) });
  assert.strictEqual(sp.speak('hello'), true);
  assert.strictEqual(sp.isSpeaking(), true);
});

// --- the teardown ordering --------------------------------------------------
//
// A source-shape pin, because the defect is an ORDER and no runtime fixture
// reaches it: `watcher.stop()` calls `_flushPending()`, which re-enters
// _maybeSpeak and can START a narration. A speaker stopped BEFORE it therefore
// leaves a dead seat — or an exiting app — still talking.

test('the speaker is stopped AFTER the thing that can start it speaking', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  // Scoped to a WINDOW around the flushing call, never a file-wide indexOf:
  // both files hold other, legitimate `speaker.stop()` calls — the window-close
  // one in session-manager.js precedes this code entirely — and a bare search
  // measures whichever came first in the file rather than the pair under test.
  const WINDOW = 600;
  for (const [file, starter] of [
    ['session-manager.js', 'if (s.watcher) s.watcher.stop();'],
    ['engine.js', 'manager.killAll();'],
  ]) {
    const src = fs.readFileSync(path.join(__dirname, '..', file), 'utf-8');
    const at = src.indexOf(starter);
    assert.ok(at > 0, `${file}: the flushing call must still exist`);
    assert.ok(src.indexOf(starter, at + 1) === -1,
      `${file}: \`${starter}\` must be unique, or this pin is reading the wrong one`);
    const after = src.slice(at + starter.length, at + starter.length + WINDOW);
    const before = src.slice(Math.max(0, at - WINDOW), at);
    assert.ok(after.includes('speaker.stop()'),
      `${file}: speaker.stop() must follow \`${starter}\` — the flush can start a narration`);
    assert.ok(!before.includes('speaker.stop()'),
      `${file}: speaker.stop() must NOT precede \`${starter}\` — that is the defect this pins`);
  }
});

function requireDefaults() {
  // stores.js is a factory over electron paths; the defaults table is a module
  // constant, read here without constructing a store.
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'stores.js'), 'utf-8');
  const speakReplies = /^\s*speakReplies:\s*(\w+),/m.exec(src);
  const speakVoice = /^\s*speakVoice:\s*'([^']+)',/m.exec(src);
  const speakRate = /^\s*speakRate:\s*(\d+),/m.exec(src);
  assert.ok(speakReplies && speakVoice && speakRate, 'the defaults must be declared in DEFAULT_UI_SETTINGS');
  return {
    DEFAULT_UI_SETTINGS: {
      speakReplies: speakReplies[1] === 'true',
      speakVoice: speakVoice[1],
      speakRate: Number(speakRate[1]),
    },
  };
}
