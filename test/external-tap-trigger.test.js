'use strict';

// external-tap-trigger.test.js — the ensure-on tap an OUTSIDE script asks for,
// and the seat it lands on.
//
// Its own file rather than cases in voice-submit.test.js: the routing half needs
// a SessionManager and the decision half needs a fake terminal, and the two
// halves are what this feature is. The predicates they lean on are pinned where
// they live; nothing here re-asserts those.
//
// EVERY DECISION ASSERTION IS ON THE BYTES THAT REACHED THE PTY, never on a
// predicate's return. A gate can be deleted and leave every function in
// lib/voice-submit.js still answering correctly while the character goes out
// anyway — which is the failure this whole subsystem is shaped around.

const { test, afterEach } = require('node:test');
const assert = require('node:assert');

const { createVoiceSubmitWatcher } = require('../renderer/voice-submit-watcher');
const { API_CONTRACT } = require('../api-contract');

// Measured off a live seat 2026-08-31 (CLI 2.1.251), same literals as
// voice-submit.test.js: the separator is a NON-BREAKING space, and spelling it
// as an ASCII one is what once left a rule returning false on every real
// composer with the suite green. Duplicated rather than exported from that
// file — a shared fixture would let one edit move both sides of every
// assertion at once.
// Spelled as escapes so an editor cannot silently "fix" the separator: it is a
// NON-BREAKING space, and an ASCII one here makes every empty-composer fixture
// read as a draft — the feature dead and the suite green.
const EMPTY_COMPOSER = '\u276f\u00a0';
const REC_ROW = ' agents \u23faREC \u00b7 tap to send';
const IDLE_ROW = ' agents \u00b7 tap to talk';

// Cursor on the LAST row unless a row carries `cursor: true` — so a fixture
// that paints the composer with an indicator BELOW it must mark the composer
// row explicitly, or the cursor lands on the indicator and the composer read
// looks at the wrong line entirely.
//
// `indicatorUnreadable` throws from the ROW COUNT, which is the one thing the
// indicator scan reads and the composer read does not — the only way to put the
// watcher in "cannot see the recorder, can see the composer", which is the state
// the polarity rule is about.
function fakeTerminal({ rows = [''], type = 'normal', indicatorUnreadable = false } = {}) {
  const state = { rows: rows.map((r) => (typeof r === 'string' ? { text: r } : r)), type, cursorXThrows: false };
  const cursorIndex = () => {
    const marked = state.rows.findIndex((r) => r && r.cursor);
    return marked === -1 ? state.rows.length - 1 : marked;
  };
  return {
    get rows() {
      if (indicatorUnreadable) throw new Error('screen unreadable');
      return state.rows.length;
    },
    buffer: {
      get active() {
        return {
          type: state.type,
          baseY: 0,
          get cursorY() { return cursorIndex(); },
          get cursorX() {
            // THE ONLY SEAM that reaches `cursorRow`'s throw. `indicatorRows`
            // swallows its own exceptions and returns null, so a fixture that
            // throws from the row count or the cursor ROW declines at the
            // unreadable-indicator gate above and never consults the composer
            // read at all — passing for the wrong reason. `cursorX` is read by
            // `cursorRow` and by nothing else on this path.
            if (state.cursorXThrows) throw new Error('cursor unreadable');
            const r = state.rows[cursorIndex()];
            return typeof r.cursorX === 'number' ? r.cursorX : r.text.length;
          },
          getLine: (y) => {
            const r = state.rows[y];
            if (!r) return null;
            return {
              translateToString: (_trim, start, end) =>
                r.text.slice(start ?? 0, end ?? r.text.length),
            };
          },
        };
      },
    },
    onWriteParsed() { return { dispose() {} }; },
    _state: state,
  };
}

// Every watcher holds the composition poll's setInterval, so an assertion that
// throws jumps over its own dispose() and the surviving interval would hang the
// run on a timeout instead of naming the failure.
const live = [];
afterEach(() => { while (live.length) live.pop().dispose(); });

function tapHarness({
  // `cursor: true` is REQUIRED on the composer row of any multi-row paint: the
  // fake puts the cursor on the LAST row, and the real footer paints the
  // indicator BELOW the composer. Without it the composer read reads the
  // indicator row and every case here passes for the wrong reason.
  rows = [{ text: EMPTY_COMPOSER, cursor: true }, IDLE_ROW],
  type = 'normal',
  attention = null,
  voiceMode = 'tap',
  trigger = ' ',
  indicatorUnreadable = false,
  // The real settle is 1.5s of wall clock. Shortened here so the deferral cases
  // do not each cost that: what they assert is the ORDERING across the wait —
  // nothing written before it, gates read after it — and neither depends on the
  // duration. The NUMBER itself is a measured claim about the CLI's watcher and
  // is pinned as source below, where no fixture can drift it.
  modeSettleMs = 5,
} = {}) {
  const writes = [];
  const env = { attention, voiceMode, trigger };
  const term = fakeTerminal({ rows, type, indicatorUnreadable });
  // A CONTROLLED CLOCK, so the repaint band can be crossed without sleeping
  // through it and without making the assertion depend on wall-clock timing.
  const clock = { t: 1_000_000 };
  const watcher = createVoiceSubmitWatcher(term, {
    now: () => clock.t,
    // The external tap is deliberately NOT gated on the hands-free-submit
    // config, so this returns one enabled: a harness that switched it off would
    // pass every silence assertion below for the wrong reason.
    getConfig: () => ({ enabled: true, rearm: true, phrase: 'over and out' }),
    getAttention: () => env.attention,
    getVoiceMode: () => env.voiceMode,
    getTriggerKey: () => env.trigger,
    write: (d) => writes.push(d),
    modeSettleMs,
  });
  live.push(watcher);
  return {
    watcher, writes, env, clock,
    // Arms the cursor read to throw, for the one case that needs a gate to fail
    // AFTER the settle wait rather than before it.
    throwFromCursor: () => { term._state.cursorXThrows = true; },
  };
}

// ---------------------------------------------------------------- the polarity

// THE TRAP THIS FEATURE WAS DESIGNED AROUND, and the reason it does not reuse
// `recordingObserved` as its gate.
//
// That predicate answers FALSE for an unreadable screen — right where it feeds
// the voice-origin marker, fatal here. The obvious `if (!recordingObserved(rows))
// tap()` therefore takes the WRITE branch on a screen nobody can read, and if
// the recorder was in fact lit that character STOPS it, mid-sentence.
//
// The errors are not symmetric, which is the whole argument: declining while
// the mic was dark costs one repeated wake word, writing while it was lit costs
// the sentence being spoken. So the null is tested here explicitly.
//
// REACHING THE STATE IT NAMES took a specific fixture, and the obvious one does
// not. On the ALTERNATE buffer both reads decline, so the composer gate blocks
// the write and the null branch is never consulted — that version of this test
// passed against the trap implementation, i.e. pinned nothing. This one fails
// the indicator read ALONE: `indicatorRows` walks `terminal.rows` inside its
// try/catch and `cursorRow` never touches it, so the composer still reads clean
// and empty. That is the only shape where the null branch is what decides.
test('THE POLARITY: an unreadable INDICATOR is never written to, even with a clean composer', () => {
  const h = tapHarness({ indicatorUnreadable: true });
  assert.strictEqual(h.watcher.externalTap(), false);
  assert.deepStrictEqual(h.writes, [],
    'a character written here would STOP a recording that may well be live');
  assert.strictEqual(h.watcher.externalTapCount(), 0);
});

test('the ALTERNATE buffer is not written to either', () => {
  // A full-screen program is up: neither read means anything. Blocked by the
  // composer gate rather than by the null branch above — kept as its own case
  // precisely so the two reasons stay distinguishable.
  const h = tapHarness({ type: 'alternate' });
  assert.strictEqual(h.watcher.externalTap(), false);
  assert.deepStrictEqual(h.writes, []);
});

// THE PROCESSING WINDOW, and it sits on this feature's HAPPY PATH rather than
// in a corner. t587's stop-at-submit writes the key at the end of a dictated
// turn, the recorder enters processing, and processing is the first moment
// Voice Control can hear a wake word again — so the tap this feature exists to
// deliver is aimed straight into this window. The two features compose into the
// bug.
//
// The CLI REPLACES the lit indicator with this row rather than adding to it, so
// `recordingObserved` reads NOT-LIT for the whole window while the composer is
// still clean. Measured in 2.1.251: the tap handler's processing arm returns
// WITHOUT swallowing a single-character binding, so the byte falls through as a
// LITERAL into the composer — and from then on `composerIsEmpty` is false, which
// blocks every later re-arm AND every later external tap. A permanently stuck
// mic that only a manual composer clear escapes.
//
// NOT VACUOUS, by the same bar the null case had to clear: the composer reads
// clean here and no permission dialog is up, so every earlier guard PASSES and
// the processing gate is the only thing that can decline. A fixture an earlier
// guard already rejects would pin nothing.
//
// Both spellings, for the reason t587's table gives: the CLI's real bytes carry
// a single U+2026, and a rule anchored on that ellipsis would pass the first row
// and fail the ASCII form a normalisation produces.
test('THE PROCESSING WINDOW gets no character — the byte would land as a literal', () => {
  for (const row of [
    ' agents Voice: processing\u2026',
    ' agents Voice: processing...',
  ]) {
    const h = tapHarness({ rows: [{ text: EMPTY_COMPOSER, cursor: true }, row] });
    assert.strictEqual(h.watcher.externalTap(), false, JSON.stringify(row));
    assert.deepStrictEqual(h.writes, [], JSON.stringify(row));
    assert.strictEqual(h.watcher.externalTapCount(), 0, JSON.stringify(row));
  }
});

test('a recorder already LIT is left alone — ensure-on, never toggle', () => {
  const h = tapHarness({ rows: [{ text: EMPTY_COMPOSER, cursor: true }, REC_ROW] });
  assert.strictEqual(h.watcher.externalTap(), false);
  assert.deepStrictEqual(h.writes, [], 'the byte would STOP the live recording');
  assert.strictEqual(h.watcher.externalTapCount(), 0);
});

// Without this row the two above pass for a gate that blocks unconditionally:
// the feature would be dead and the suite green. It is the only case here that
// asserts a byte WAS written.
test('a DARK recorder and an empty composer gets the trigger character', () => {
  const h = tapHarness();
  assert.strictEqual(h.watcher.externalTap(), true);
  assert.deepStrictEqual(h.writes, [' ']);
  assert.strictEqual(h.watcher.externalTapCount(), 1);
});

test('the character written is the CONFIGURED one, not a hardcoded space', () => {
  const h = tapHarness({ trigger: 'k' });
  h.watcher.externalTap();
  assert.deepStrictEqual(h.writes, ['k']);
});

test('no single character is bound to push-to-talk: nothing is written', () => {
  // A modifier chord resolves to null upstream, and a space written in hope
  // would just type into the draft.
  const h = tapHarness({ trigger: null });
  assert.strictEqual(h.watcher.externalTap(), false);
  assert.deepStrictEqual(h.writes, []);
});

test('HOLD mode is not tapped', () => {
  // The swallow-and-toggle measured in the CLI is the tap branch specifically;
  // in hold mode one written character cannot reach the auto-repeat threshold,
  // so it lands in the draft as a literal and arms nothing.
  const h = tapHarness({ voiceMode: 'hold' });
  assert.strictEqual(h.watcher.externalTap(), false);
  assert.deepStrictEqual(h.writes, []);
});

test('a NON-EMPTY composer is not tapped', () => {
  // The CLI's tap handler bails on a non-empty composer BEFORE it swallows the
  // key, so the character would be inserted into the operator's draft — and the
  // now-non-empty composer blocks every later re-arm too.
  const h = tapHarness({ rows: [{ text: '❯ half a thought', cursor: true }, IDLE_ROW] });
  assert.strictEqual(h.watcher.externalTap(), false);
  assert.deepStrictEqual(h.writes, []);
});

test('a seat showing a PERMISSION dialog is not tapped', () => {
  // Any byte written into an open dialog ANSWERS it. This gate cannot be
  // inherited from the re-arm's: that one additionally requires hands-free
  // submit to be switched on, and this feature is not that one.
  const h = tapHarness({ attention: 'permission' });
  assert.strictEqual(h.watcher.externalTap(), false);
  assert.deepStrictEqual(h.writes, []);
});

test('a disposed watcher writes nothing', () => {
  const h = tapHarness();
  h.watcher.dispose();
  assert.strictEqual(h.watcher.externalTap(), false);
  assert.deepStrictEqual(h.writes, []);
});

// ------------------------------------------------------------------ the routing

// The REAL manager, from the real factory, with the deps voiceTap's path
// touches. Source-shape assertions were the alternative and are strictly
// weaker: they pass for a method that reads the right fields and sends
// nothing.
function mk(overrides = {}) {
  const { createSessionManager } = require('../session-manager');
  const SessionManager = createSessionManager({
    getRemoteServer: () => null,
    getUiSettings: () => ({ get: () => ({}) }),
    getPersistence: () => ({ list: () => [], get: () => null }),
    notifyOS: () => {},
    intentEnabled: require('../intent-catalog').intentEnabled,
    withoutPrivilegedIntentsFor: require('../intent-registry').withoutPrivilegedIntentsFor,
    fencedLines: require('../intent-scanner').fencedLines,
    bodyModeFor: require('../intent-registry').bodyModeFor,
    intentEnabledFor: require('../intent-registry').intentEnabledFor,
    pluginRowFor: require('../intent-registry').pluginRowFor,
    validIntentNames: require('../intent-registry').validIntentNames,
    fs: require('node:fs'),
    countPending: require('../pending-store').countPending,
    isDraftOpen: require('../proxy-util').isDraftOpen,
    drainPending: require('../pending-store').drainPending,
    hasActivePending: require('../pending-store').hasActivePending,
    spillToFile: () => '/tmp/spill-stub.txt',
    MSG_MAX_AGE: 1800,
    termAvailableFor: require('../drawer-avail').termAvailableFor,
    // Silent by default. Three tests in this file have now failed on a missing
    // `log` rather than on their subject — every decline path logs, so a
    // fixture without one turns any new decline into a TypeError that reads
    // like a bug in the code under test.
    log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    // The tap now consults the voice mode and moves it off `hold`, so its path
    // touches both. Defaulted to a file ALREADY on tap: that is the no-write
    // case, so every fixture here keeps asserting the routing without a settings
    // write riding along. The mode-change half supplies its own pair.
    readVoiceMode: () => ({ file: '/tmp/fake/settings.json', source: 'voice', mode: 'tap', enabled: true, legacy: null, effective: 'tap' }),
    writeVoiceMode: (mode) => ({ ok: true, mode, file: '/tmp/fake/settings.json' }),
    ...overrides,
  });
  return new SessionManager();
}

function fakeWin({ focused = true } = {}) {
  const win = {
    sent: [],
    // Controllable, because "which window is in front" is now the authority for
    // moving the microphone — a fixture that cannot express a BACKGROUND window
    // cannot reach the case that matters.
    focused,
    // The raise is recorded in the SAME list as the frames, so a test can
    // assert that the window came forward BEFORE the tap frame went out —
    // ordering that two separate counters could not express.
    raised: [],
    webContents: { send: (...a) => win.sent.push(a) },
    isDestroyed: () => false,
    isFocused: () => win.focused,
    show() { win.raised.push('show'); win.sent.push(['#show']); },
    focus() { win.raised.push('focus'); win.sent.push(['#focus']); },
  };
  return win;
}

// A claude seat with a window attached, which is the only shape a tap can land
// on. `workspaceId` is what windowForSession resolves through.
function seat(m, name, { agentType = 'claude', dead = false } = {}) {
  const win = fakeWin();
  m.registerWindow('ws1', win);
  m.sessions.set(name, { name, agentType, workspaceId: 'ws1', _dead: dead });
  return win;
}

test('an explicit target is preferred over the focused seat', () => {
  const m = mk();
  const win = fakeWin();
  m.registerWindow('ws1', win);
  m.sessions.set('watched', { name: 'watched', agentType: 'claude', workspaceId: 'ws1' });
  m.sessions.set('named', { name: 'named', agentType: 'claude', workspaceId: 'ws1' });
  reportFrom(m, win, 'watched');

  assert.deepStrictEqual(m.voiceTap('named'), { ok: true, name: 'named' });
  // The whole frame: a tap that reached the right seat over the wrong channel
  // is as dead as one that reached nobody.
  //
  // THE RETARGET RIDES AHEAD OF THE TAP, and the order is the assertion:
  // the seat must not receive its own tap while another seat is still recorded
  // as holding the microphone. A tap NAMES a seat, so it takes the microphone;
  // the automatic re-arm names nobody and never does.
  // NO raise here: the app is already frontmost, which is what `reportFrom`
  // establishes. The backgrounded case, where the tap DOES raise, is pinned in
  // the FOCUS block below.
  assert.deepStrictEqual(win.sent,
    [['app-focused', true], ['mic-target', 'watched'], ['mic-target', 'named'],
      ['voice-tap', 'named', false]],
    'a script can address a seat the operator is not looking at');
});

test('no target falls back to the focused seat', () => {
  const m = mk();
  const win = seat(m, 'watched');
  reportFrom(m, win, 'watched');
  // The focus report already made it the target, so the tap has nothing to move
  // — the idempotence guard is what keeps a second frame off the wire here.
  assert.deepStrictEqual(m.voiceTap(), { ok: true, name: 'watched' });
  assert.deepStrictEqual(win.sent,
    [['app-focused', true], ['mic-target', 'watched'], ['voice-tap', 'watched', false]]);
});

test('no target and nothing focused declines rather than guessing a seat', () => {
  const m = mk();
  const win = seat(m, 'lonely');
  // The ONLY live seat is deliberately present: a fallback of "the only one" or
  // "the first one" would pass a test where the map was empty.
  const r = m.voiceTap();
  assert.strictEqual(r.ok, false);
  assert.deepStrictEqual(win.sent, [], 'no seat was reported focused, so none is tapped');
});

test('a cleared focus stops routing at the seat that went away', () => {
  const m = mk();
  const win = seat(m, 'watched');
  reportFrom(m, win, 'watched');
  reportFrom(m, win, null);
  assert.strictEqual(m.voiceTap().ok, false);
  // The microphone was RELEASED with the focus, and the null is what releases
  // it: a target left pointing at the seat that went away would let that seat's
  // window go on believing it may arm.
  assert.deepStrictEqual(win.sent,
    [['app-focused', true], ['mic-target', 'watched'], ['mic-target', null]],
    'no tap frame — and the target was cleared, not merely left behind');
});

test('a DEAD seat, a BASH seat and an UNKNOWN name are each declined', () => {
  for (const [label, setup] of [
    ['dead', (m) => { seat(m, 's', { dead: true }); return 's'; }],
    ['bash', (m) => { seat(m, 's', { agentType: null }); return 's'; }],
    ['unknown', (m) => { seat(m, 's'); return 'someone-else'; }],
  ]) {
    const m = mk();
    const target = setup(m);
    const win = m.windowForWorkspace('ws1');
    const r = m.voiceTap(target);
    assert.strictEqual(r.ok, false, `${label}: declined`);
    assert.deepStrictEqual(win.sent, [], `${label}: no frame sent`);
  }
});

test('a seat whose window is gone is declined', () => {
  const m = mk();
  m.sessions.set('detached', { name: 'detached', agentType: 'claude', workspaceId: 'ws-closed' });
  m.noteFocusedSession('detached');
  // The renderer owns the decision, so a seat with no renderer attached has
  // nobody to make it — routing there would drop the tap silently.
  assert.strictEqual(m.voiceTap().ok, false);
});

test('the socket arm dispatches voice-tap and delivers it to NO transcript', () => {
  const m = mk();
  const win = seat(m, 'watched');
  reportFrom(m, win, 'watched');
  // Arrives on some agent's socket — `targetName` is whichever socket the
  // sender could reach, NOT the seat acted on. Asserting that distinction is
  // the point of routing to 'watched' from a message addressed to 'courier'.
  m.sessions.set('courier', { name: 'courier', agentType: 'claude', workspaceId: 'ws1' });
  m._onIncoming('courier', { type: 'voice-tap', from: 'voice-tap' });

  assert.deepStrictEqual(win.sent,
    [['app-focused', true], ['mic-target', 'watched'], ['voice-tap', 'watched', false]],
    'the socket it arrived on identifies the app, not the seat');
});

test('the socket arm honours an explicit target on the envelope', () => {
  const m = mk();
  const win = fakeWin();
  m.registerWindow('ws1', win);
  m.sessions.set('courier', { name: 'courier', agentType: 'claude', workspaceId: 'ws1' });
  m.sessions.set('named', { name: 'named', agentType: 'claude', workspaceId: 'ws1' });
  reportFrom(m, win, 'courier');
  m._onIncoming('courier', { type: 'voice-tap', from: 'voice-tap', target: 'named' });
  // The focus put the microphone on 'courier'; the NAMED target takes it away.
  assert.deepStrictEqual(win.sent,
    [['app-focused', true], ['mic-target', 'courier'], ['mic-target', 'named'],
      ['voice-tap', 'named', false]]);
});

// ----------------------------------------------- the microphone has ONE target

// Main owns WHICH SEAT holds the microphone, box-wide, for the reason it owns
// the speaker flag — there is one microphone, and `activeSession` is
// per-WINDOW, so two workspace windows each have a seat that is "active" and a
// locally-evaluated permission answers yes in both. That is how the operator's
// dictation reached two composers at once.
//
// The asymmetry between the two writers is the design and is pinned below: a
// TAP names a seat, so it may take the microphone; the automatic re-arm names
// nobody, so it may only ever arm whoever already holds it (that half is
// enforced in the renderer and pinned in voice-submit.test.js).

// A second workspace window, which is what makes the box-wide claim testable at
// all: a value delivered only to the holder's window leaves the LOSER believing
// it may still arm, and the loser is the seat that caused this bug.
function twoWindows(m) {
  const a = fakeWin();
  const b = fakeWin();
  m.registerWindow('ws1', a);
  m.registerWindow('ws2', b);
  m.sessions.set('A', { name: 'A', agentType: 'claude', workspaceId: 'ws1' });
  m.sessions.set('B', { name: 'B', agentType: 'claude', workspaceId: 'ws2' });
  return { a, b };
}

// A focus report as it actually ARRIVES: from a named window, with the app in
// some state. Calling `noteFocusedSession(name)` bare is what left the load-
// bearing case unpinned — it asserts about a report from nowhere.
function reportFrom(m, win, name, { appFocused = true } = {}) {
  m.noteAppFocused(appFocused);
  m.noteFocusedSession(name, win);
}

test('MIC: the focus report sets the target, and EVERY window is told', () => {
  const m = mk();
  const { a, b } = twoWindows(m);
  reportFrom(m, a, 'A');
  assert.strictEqual(m.micTarget(), 'A');
  // BOTH windows, and B's frame is the load-bearing one: B's seat has to learn
  // it does NOT hold the microphone, which is the only thing that stops it
  // arming when its own turn ends.
  assert.deepStrictEqual(a.sent, [['app-focused', true], ['mic-target', 'A']]);
  assert.deepStrictEqual(b.sent, [['app-focused', true], ['mic-target', 'A']],
    'the losing window is told too');
});

test('MIC: switching focus moves it, so two seats can never both hold it', () => {
  const m = mk();
  const { a, b } = twoWindows(m);
  reportFrom(m, a, 'A');
  // From WINDOW 2, which must be the one in front for its report to count.
  a.focused = false;
  reportFrom(m, b, 'B');
  assert.strictEqual(m.micTarget(), 'B');
  // The frames in order: the SECOND is what takes it off A. A design that only
  // ever added a holder would leave both live, which is the bug.
  assert.deepStrictEqual(a.sent,
    [['app-focused', true], ['mic-target', 'A'], ['mic-target', 'B']]);
});

test('MIC: a repeated report of the SAME seat broadcasts once', () => {
  // The renderer reports on every window focus, so this repeats whenever the
  // operator alt-tabs. Without the equality guard each one puts a frame on
  // every window for a value that did not change.
  const m = mk();
  const { a, b } = twoWindows(m);
  reportFrom(m, a, 'A');
  reportFrom(m, a, 'A');
  reportFrom(m, a, 'A');
  assert.deepStrictEqual(a.sent, [['app-focused', true], ['mic-target', 'A']]);
  assert.deepStrictEqual(b.sent, [['app-focused', true], ['mic-target', 'A']]);
});

test('MIC: an EXPLICIT tap takes the microphone from the focused seat', () => {
  // The asymmetry, in the direction that MOVES it. He named B out loud while
  // looking at A. The tap is used with another app in front — that is the
  // point of it — so requiring Clodex to be frontmost would break the feature
  // outright. Naming a seat is the deliberate act that earns the retarget.
  const m = mk();
  const { a, b } = twoWindows(m);
  reportFrom(m, a, 'A');
  assert.deepStrictEqual(m.voiceTap('B'), { ok: true, name: 'B' });
  assert.strictEqual(m.micTarget(), 'B');
  // A still believes it is the FOCUSED seat — the two records are deliberately
  // separate — but it no longer holds the microphone.
  assert.strictEqual(m._focusedSession, 'A',
    'the tap moves the microphone and leaves the focus record alone');
  assert.deepStrictEqual(a.sent,
    [['app-focused', true], ['mic-target', 'A'], ['mic-target', 'B']]);
  assert.deepStrictEqual(b.sent,
    [['app-focused', true], ['mic-target', 'A'], ['mic-target', 'B'], ['voice-tap', 'B', false]]);
});

test('MIC: a tap that DECLINES does not move the microphone', () => {
  // Every decline in voiceTap is above the retarget, so a tap that routed
  // nowhere cannot take the microphone off the seat that has it and leave the
  // box with no holder at all — which would silence the re-arm everywhere.
  for (const [label, target, setup] of [
    ['unknown name', 'ghost', () => {}],
    ['dead seat', 'D', (m) => m.sessions.set('D', { name: 'D', agentType: 'claude', workspaceId: 'ws1', _dead: true })],
    ['bash seat', 'S', (m) => m.sessions.set('S', { name: 'S', agentType: null, workspaceId: 'ws1' })],
    ['no window', 'X', (m) => m.sessions.set('X', { name: 'X', agentType: 'claude', workspaceId: 'ws-closed' })],
  ]) {
    const m = mk();
    const { a } = twoWindows(m);
    setup(m);
    reportFrom(m, a, 'A');
    assert.strictEqual(m.voiceTap(target).ok, false, `${label}: declined`);
    assert.strictEqual(m.micTarget(), 'A', `${label}: A still holds it`);
    assert.deepStrictEqual(a.sent, [['app-focused', true], ['mic-target', 'A']],
      `${label}: no second frame`);
  }
});

test('MIC: nothing focused releases the microphone rather than stranding it', () => {
  const m = mk();
  const { a, b } = twoWindows(m);
  reportFrom(m, a, 'A');
  reportFrom(m, a, null);
  assert.strictEqual(m.micTarget(), null);
  // The null has to REACH the windows: a holder left recorded on a seat that
  // went away is a seat whose window still believes it may arm.
  assert.deepStrictEqual(a.sent,
    [['app-focused', true], ['mic-target', 'A'], ['mic-target', null]]);
  assert.deepStrictEqual(b.sent,
    [['app-focused', true], ['mic-target', 'A'], ['mic-target', null]]);
});

test('MIC: it starts held by NOBODY', () => {
  // Before any window has reported, no seat may arm. The opposite default
  // would arm every seat at launch, which is the bug at its widest.
  const m = mk();
  assert.strictEqual(m.micTarget(), null);
});

test('MIC: the pull answers what a window that opened mid-dictation missed', () => {
  // The broadcast is an EDGE and the target does not move again while he keeps
  // talking to the seat he already picked, so a window opened after it would
  // never learn the holder without this read — and its seat could never arm.
  const m = mk();
  const { a } = twoWindows(m);
  reportFrom(m, a, 'A');
  const late = fakeWin();
  m.registerWindow('ws3', late);
  assert.deepStrictEqual(late.sent, [], 'it missed the broadcast, by construction');
  assert.strictEqual(m.micTarget(), 'A', 'and the pull is how it catches up');
});

test('MIC: the contract carries both halves with the kinds each relies on', () => {
  const rows = new Map(API_CONTRACT.map((r) => [r.name, r]));
  // The WHOLE row: an `on` that became `invoke` would silently stop delivering
  // the broadcast, and the losing window would go on believing it holds the
  // microphone — which is the failure with no visible symptom until he speaks.
  assert.deepStrictEqual(rows.get('onMicTarget'),
    { name: 'onMicTarget', kind: 'on', channel: 'mic-target' });
  assert.deepStrictEqual(rows.get('micTarget'),
    { name: 'micTarget', kind: 'invoke', channel: 'voice:micTarget' });
});

test('MIC: the voice:micTarget handler is registered and returns the target', () => {
  // The REGISTERED handler, for the reason its neighbour below gives: a test
  // calling the method directly stays green if the channel was never wired.
  const { registerIpcHandlers } = require('../ipc-handlers');
  const handlers = new Map();
  registerIpcHandlers({
    handle: (ch, fn) => handlers.set(ch, fn),
    on: () => {},
    manager: { micTarget: () => 'A' },
    log: { info() {}, error() {} },
  });
  const fn = handlers.get('voice:micTarget');
  assert.ok(fn, 'voice:micTarget is registered');
  assert.strictEqual(fn({}), 'A');
});

// A REPORT FROM A BACKGROUND WINDOW takes nothing. This is the third door onto
// the same bug: `reportFocusedSession()` is unconditional in every window, and
// `switchSession` reaches it with NO operator action at all — a seat exiting in
// a background window switches that window to its next seat and reports it.
// Session exits are the most common automatic event in this box.
//
// Retargeting on that moved the microphone off the seat he was dictating into
// and onto one he could not see; both later gates then pass for that seat (it
// IS the target, the app IS frontmost), so it arms. The incident, reproduced
// with the frontmost fix in place.
//
// The rule the whole ticket keeps re-learning: a box-wide resource may only be
// written from a source that is itself box-wide. The window supplies the NAME;
// the authority to move the microphone is the two box-wide facts.

test('REPORTER: a background window reports its seat and takes NOTHING', () => {
  const m = mk();
  const { a, b } = twoWindows(m);
  reportFrom(m, a, 'A');            // he is dictating into A, in window 1
  a.sent.length = 0; b.sent.length = 0;

  // Window 2 is NOT the front window; its ephemeral seat just exited and it
  // switched to C, which reports with no operator action whatsoever.
  m.sessions.set('C', { name: 'C', agentType: 'claude', workspaceId: 'ws2' });
  b.focused = false;
  m.noteFocusedSession('C', b);

  assert.strictEqual(m.micTarget(), 'A',
    'the seat he is dictating into keeps the microphone');
  assert.deepStrictEqual(a.sent, [], 'no mic-target frame went out at all');
  assert.deepStrictEqual(b.sent, []);
  // ROUTING still moved, and must: an external tap naming no seat follows the
  // last report even from a background window — that is the whole point of
  // addressing a seat from outside the app, and not a regression to trade away
  // for this fix.
  assert.strictEqual(m._focusedSession, 'C',
    'the routing record is deliberately NOT gated — only the microphone is');
});

test('REPORTER: the same report from the FRONT window DOES move it', () => {
  // The other direction, one flag apart, or the pin above is satisfied by a
  // build where the microphone never moves at all.
  const m = mk();
  const { a, b } = twoWindows(m);
  reportFrom(m, a, 'A');
  a.sent.length = 0; b.sent.length = 0;

  m.sessions.set('C', { name: 'C', agentType: 'claude', workspaceId: 'ws2' });
  a.focused = false;
  b.focused = true;
  m.noteFocusedSession('C', b);

  assert.strictEqual(m.micTarget(), 'C', 'he switched to that window himself');
  assert.deepStrictEqual(a.sent, [['mic-target', 'C']]);
});

test('REPORTER: a report while the APP is backgrounded takes nothing either', () => {
  // Both conditions are required, and this is the half the window flag cannot
  // express: window 1 is still Clodex's front window while Clodex itself sits
  // behind a browser. Nothing there is the operator choosing a seat.
  const m = mk();
  const { a } = twoWindows(m);
  reportFrom(m, a, 'A');
  a.sent.length = 0;

  m.noteAppFocused(false);
  a.sent.length = 0;
  m.sessions.set('C', { name: 'C', agentType: 'claude', workspaceId: 'ws1' });
  m.noteFocusedSession('C', a);

  assert.strictEqual(m.micTarget(), 'A');
  assert.deepStrictEqual(a.sent, []);
});

test('REPORTER: a report with NO window resolved takes nothing', () => {
  // `windowForWorkspace` returns null for a window that has closed, and an
  // in-flight report from one must not be treated as the operator's choice.
  const m = mk();
  const { a } = twoWindows(m);
  reportFrom(m, a, 'A');
  a.sent.length = 0;
  m.noteFocusedSession('B', null);
  assert.strictEqual(m.micTarget(), 'A');
  assert.deepStrictEqual(a.sent, []);
  assert.strictEqual(m._focusedSession, 'B', 'routing still follows it');
});

test('REPORTER: a window whose isFocused THROWS takes nothing', () => {
  const m = mk();
  const { a, b } = twoWindows(m);
  reportFrom(m, a, 'A');
  a.sent.length = 0;
  b.isFocused = () => { throw new Error('window gone'); };
  m.noteFocusedSession('B', b);
  assert.strictEqual(m.micTarget(), 'A', 'doubt does not move the microphone');
  assert.deepStrictEqual(a.sent, []);
});

// -------------------------------------------- the app must be FRONTMOST to arm

// The second condition, independent of the target. He browsed the web with
// Clodex behind it; an agent's turn ended, the re-arm fired, and the CLI
// transcribed the VIDEO into that seat's composer. The seat WAS the target, so
// the invariant above passes — nobody was talking to it.
//
// ONE RULE, not an asymmetric pair: no path arms the recorder from the
// background. What differs between the two paths is what they do about it — the
// re-arm declines (it names nobody, so it has no window it could justify
// raising), while the tap names a seat and therefore RAISES it.

test('FOCUS: it starts backgrounded, so nothing arms before the host reports', () => {
  const m = mk();
  assert.strictEqual(m.appFocused(), false);
});

test('FOCUS: the host report is mirrored and broadcast to every window', () => {
  const m = mk();
  const { a, b } = twoWindows(m);
  m.noteAppFocused(true);
  assert.strictEqual(m.appFocused(), true);
  assert.deepStrictEqual(a.sent, [['app-focused', true]]);
  assert.deepStrictEqual(b.sent, [['app-focused', true]], 'every window, like the target');
});

test('FOCUS: going to the background broadcasts the FALSE edge', () => {
  // The edge that matters: without it every seat goes on believing the app is
  // in front, which is the state that recorded.
  const m = mk();
  const { a } = twoWindows(m);
  m.noteAppFocused(true);
  m.noteAppFocused(false);
  assert.strictEqual(m.appFocused(), false);
  assert.deepStrictEqual(a.sent, [['app-focused', true], ['app-focused', false]]);
});

test('FOCUS: a repeated report of the same state broadcasts once', () => {
  // Window focus churns between sibling windows without the APP's
  // frontmost-ness changing, and both Electron edges call this.
  const m = mk();
  const { a } = twoWindows(m);
  m.noteAppFocused(true);
  m.noteAppFocused(true);
  m.noteAppFocused(true);
  assert.deepStrictEqual(a.sent, [['app-focused', true]]);
});

test('FOCUS: exactly true, not merely truthy', () => {
  for (const v of [1, 'yes', {}, [], 'true']) {
    const m = mk();
    m.noteAppFocused(v);
    assert.strictEqual(m.appFocused(), false, `noteAppFocused(${JSON.stringify(v)})`);
  }
});

test('FOCUS: a tap from the BACKGROUND raises the window, then arms', () => {
  // The ruling: focus-then-arm rather than decline. The tap already names a
  // seat, so it knows which window to bring forward — which keeps the daily
  // workflow (a wake phrase with another app in front) while removing the
  // background-recording hole.
  const m = mk();
  const { b } = twoWindows(m);
  // No 'app-focused' frame below: the flag ALREADY starts false, and the
  // idempotence guard is what keeps a redundant edge off the wire. Windows
  // default to backgrounded for the same reason, so nothing is missed.
  m.noteAppFocused(false);
  assert.deepStrictEqual(m.voiceTap('B'), { ok: true, name: 'B' });
  assert.deepStrictEqual(b.raised, ['show', 'focus'], 'the window was brought forward');
  // ORDER, which is the part a pair of counters could not express: the seat
  // holds the microphone before its window comes forward, and the tap frame
  // goes out last.
  assert.deepStrictEqual(b.sent,
    [['mic-target', 'B'], ['#show'], ['#focus'], ['voice-tap', 'B', false]]);
});

test('FOCUS: a tap with the app ALREADY in front does not re-raise it', () => {
  // Raising an app that is already frontmost is a no-op the user cannot see,
  // but it would steal focus BETWEEN windows — the tap names a seat in one
  // workspace and he may be typing in another.
  const m = mk();
  const { b } = twoWindows(m);
  m.noteAppFocused(true);
  assert.deepStrictEqual(m.voiceTap('B'), { ok: true, name: 'B' });
  assert.deepStrictEqual(b.raised, [], 'already frontmost: nothing to raise');
  assert.deepStrictEqual(b.sent,
    [['app-focused', true], ['mic-target', 'B'], ['voice-tap', 'B', false]]);
});

test('FOCUS: a host that cannot raise still routes the tap', () => {
  // web-host's handles implement show/focus, but a handle whose raise THROWS
  // must not cost the operator the tap itself — the renderer still owns the
  // decision about whether the key may be written.
  const m = mk();
  const win = fakeWin();
  win.show = () => { throw new Error('no window server'); };
  m.registerWindow('ws1', win);
  m.sessions.set('A', { name: 'A', agentType: 'claude', workspaceId: 'ws1' });
  m.noteAppFocused(false);
  assert.deepStrictEqual(m.voiceTap('A'), { ok: true, name: 'A' });
  assert.deepStrictEqual(win.sent.at(-1), ['voice-tap', 'A', false]);
});

test('FOCUS: a DECLINED tap neither raises a window nor moves the microphone', () => {
  // Every decline is above the raise, so a tap that routed nowhere cannot pull
  // the app in front of whatever the operator is doing.
  const m = mk();
  const { a } = twoWindows(m);
  reportFrom(m, a, 'A');
  m.noteAppFocused(false);
  assert.strictEqual(m.voiceTap('ghost').ok, false);
  assert.deepStrictEqual(a.raised, [], 'no window came forward for a tap that went nowhere');
  assert.strictEqual(m.micTarget(), 'A');
});

test('FOCUS: the contract carries both halves with the kinds each relies on', () => {
  const rows = new Map(API_CONTRACT.map((r) => [r.name, r]));
  assert.deepStrictEqual(rows.get('onAppFocused'),
    { name: 'onAppFocused', kind: 'on', channel: 'app-focused' });
  assert.deepStrictEqual(rows.get('appFocused'),
    { name: 'appFocused', kind: 'invoke', channel: 'voice:appFocused' });
});

test('FOCUS: the voice:appFocused handler is registered and returns the flag', () => {
  const { registerIpcHandlers } = require('../ipc-handlers');
  const handlers = new Map();
  registerIpcHandlers({
    handle: (ch, fn) => handlers.set(ch, fn),
    on: () => {},
    manager: { appFocused: () => true },
    log: { info() {}, error() {} },
  });
  const fn = handlers.get('voice:appFocused');
  assert.ok(fn, 'voice:appFocused is registered');
  assert.strictEqual(fn({}), true);
});

test('FOCUS: main reports the APP’s focus, not a window’s', () => {
  // A source-shape pin, because the distinction is invisible at runtime here
  // and is the entire reason this condition exists: `win.isFocused()` is true
  // for the focused window of an application that is itself behind a browser.
  // Only `app.isFocused()` answers the question that was asked.
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf-8');
  assert.match(src, /noteAppFocused\(app\.isFocused\(\)\)/,
    'main must report app.isFocused(), never a window-level focus read');
  // The backstop pair RE-DERIVES the flag, so on darwin it must not be
  // registered at all: on an ordering where `browser-window-blur` runs after
  // `did-resign-active`, the re-read answers true mid-resign and flips the flag
  // back — the stuck-true no-op the app-level pair below exists to prevent.
  // Off darwin the pair is the only cover, and BOTH edges are needed or the
  // flag sticks the other way: focus without blur never releases, blur without
  // focus never re-arms. Matched as ONE block for that reason.
  const guarded = src.match(
    /if \(process\.platform !== 'darwin'\) \{\s*app\.on\('browser-window-focus', reportAppFocus\);\s*app\.on\('browser-window-blur', reportAppFocus\);\s*\}/);
  assert.ok(guarded, 'both backstop edges must be registered together, under the non-darwin guard');
  // And NOWHERE else. Without this, re-adding an unguarded registration leaves
  // the assertion above green while the darwin hazard is back — the substring
  // match that used to stand here had exactly that hole.
  assert.doesNotMatch(src.replace(guarded[0], ''), /app\.on\('browser-window-(focus|blur)'/,
    'no backstop edge may be registered outside the guard');
  // The startup SEED stays on every platform: it reads once, before any edge,
  // so it cannot undo one, and without it a launch into the foreground waits
  // for the first alt-tab. Moving it inside the guard would break darwin.
  assert.match(src, /\}\n\s*reportAppFocus\(\);/,
    'the startup seed must sit outside the guard');

  // THE APP-LEVEL EDGES, and the FALSE they must carry. `app.isFocused()` read
  // inside `browser-window-blur` is the one read that decides "he alt-tabbed
  // away", and on macOS it is widely observed to still answer true while the
  // app is resigning active — which leaves the flag stuck true and turns the
  // whole frontmost condition into a no-op with a green suite. These two edges
  // carry the answer in their identity, so no path has to re-derive it.
  //
  // The VALUE is asserted, not just the subscription: a `did-resign-active`
  // wired to `app.isFocused()` would restate the very bug this replaces.
  assert.match(src, /app\.on\('did-become-active', \(\) => \{[^}]*noteAppFocused\(true\)/,
    'did-become-active must report TRUE by identity');
  assert.match(src, /app\.on\('did-resign-active', \(\) => \{[^}]*noteAppFocused\(false\)/,
    'did-resign-active must report FALSE by identity, never a re-read');
});

// ----------------------------------------------------------------- the contract

test('the two contract rows exist with the kinds the halves rely on', () => {
  const rows = new Map(API_CONTRACT.map((r) => [r.name, r]));
  // The WHOLE row each time: a kind that silently became 'invoke' would put a
  // round trip in front of a focus report, and a channel rename would leave
  // both halves compiling and neither talking.
  assert.deepStrictEqual(rows.get('noteFocusedSession'),
    { name: 'noteFocusedSession', kind: 'send', channel: 'session:focused' });
  assert.deepStrictEqual(rows.get('onVoiceTap'),
    { name: 'onVoiceTap', kind: 'on', channel: 'voice-tap' });
});

test('the session:focused handler records the name, and null CLEARS it', () => {
  // The REGISTERED handler, not a hand-rolled call to noteFocusedSession: the
  // hop under test is the channel wiring, and a test that calls the method
  // directly stays green if the handler is registered on the wrong channel or
  // never registered at all.
  const { registerIpcHandlers } = require('../ipc-handlers');
  const handlers = new Map();
  const calls = [];
  const senderWin = fakeWin();
  registerIpcHandlers({
    handle: () => {},
    on: (ch, fn) => handlers.set(ch, fn),
    // The handler now RESOLVES THE SENDER, which is the point of must-fix 1:
    // main must know which window spoke before it lets a report move the
    // microphone. Both seams are stubbed so the assertions below are about the
    // channel wiring and not about window bookkeeping.
    workspaceOfSender: () => 'ws1',
    manager: {
      noteFocusedSession: (n, win) => calls.push([n, win]),
      windowForWorkspace: () => senderWin,
    },
    log: { info() {}, error() {} },
  });
  const fn = handlers.get('session:focused');
  assert.ok(fn, 'session:focused is registered — without this the assertions below read around a missing channel');

  fn({}, 'watched');
  // NULL IS LOAD-BEARING, not a defensive nicety: renderer.js clears the record
  // when the last seat closes, and a handler that coerced this to the string
  // "null" would leave an external tap aiming at a seat that is gone.
  fn({}, null);
  // The WINDOW rides with the name now: without it main cannot tell a report
  // from the front window apart from one a background window sent itself.
  assert.deepStrictEqual(calls, [['watched', senderWin], [null, senderWin]]);
});

test('the session:focused handler resolves the sender STRICTLY', () => {
  // The loose helper answers DEFAULT_WORKSPACE_ID for a sender whose window is
  // already gone, so a dying window's last report would be authorised against
  // whatever window the default workspace happens to hold. Strict answers null
  // there, and a null window takes nothing (pinned above). Both seams are wired
  // so the assertion is about WHICH ONE the handler asks, not about either
  // one's own resolution.
  const { registerIpcHandlers } = require('../ipc-handlers');
  const asked = [];
  const handlers = new Map();
  const calls = [];
  registerIpcHandlers({
    handle: () => {},
    on: (ch, fn) => handlers.set(ch, fn),
    workspaceOfSenderStrict: () => { asked.push('strict'); return null; },
    workspaceOfSender: () => { asked.push('loose'); return 'default'; },
    manager: {
      noteFocusedSession: (n, win) => calls.push([n, win]),
      // The real one answers null for a workspace with no live window; here it
      // must never be reached with the loose helper's 'default'.
      windowForWorkspace: (ws) => (ws == null ? null : fakeWin()),
    },
    log: { info() {}, error() {} },
  });
  const fn = handlers.get('session:focused');
  assert.ok(fn, 'session:focused is registered');

  fn({}, 'watched');
  assert.deepStrictEqual(asked, ['strict'], 'the loose fallback must not be consulted when strict is wired');
  // The NAME still travels — routing is not gated, only the microphone is. The
  // window is null, which is how noteFocusedSession is told to take nothing.
  assert.deepStrictEqual(calls, [['watched', null]]);
});

test('the sender script speaks the envelope the socket arm decodes', () => {
  const fs = require('fs');
  const path = require('path');
  const script = fs.readFileSync(
    path.join(__dirname, '..', 'scripts', 'clodex-voice-tap.js'), 'utf-8');
  const handler = fs.readFileSync(
    path.join(__dirname, '..', 'session-manager.js'), 'utf-8');

  // The one hop nothing else covers: the script BUILDS the envelope and the
  // manager DISPATCHES on its type, in two files that never import each other.
  // Spelling either side differently leaves both green in isolation and the
  // wake word silently dead.
  assert.match(script, /type: 'voice-tap'/, 'the script sends type voice-tap');
  assert.match(handler, /mtype === 'voice-tap'/, 'the manager dispatches on it');
  assert.match(script, /\.\.\.\(target \? \{ target \} : \{\}\)/,
    'an absent target is OMITTED, not sent as null — the manager reads a string or falls back to focus');
  assert.match(handler, /typeof msg\.target === 'string' \? msg\.target : null/,
    'the manager takes the target only when it is a string');

  // Node builtins only: this runs from a shortcut, with no install step and no
  // access to the app's node_modules.
  const requires = [...script.matchAll(/require\('([^']+)'\)/g)].map((m) => m[1]);
  assert.deepStrictEqual(requires.filter((r) => r.startsWith('.')), [],
    'the sender script must not require anything from the app tree');
});

// ---------------------------------------------------- the select + mode verbs

// The daily path is the thing this ticket could break: a shortcut he already
// has, invoking this script by path with zero or one argument. Byte-identical
// envelopes, not merely "still a tap".
test('VERBS: the legacy invocations build byte-identical envelopes', () => {
  const { envelopeFor } = require('../scripts/clodex-voice-tap.js');
  assert.deepStrictEqual(envelopeFor([]),
    { type: 'voice-tap', from: 'voice-tap' },
    'bare: no target key at all, exactly as before');
  assert.deepStrictEqual(envelopeFor(['wirescope']),
    { type: 'voice-tap', from: 'voice-tap', target: 'wirescope' },
    'one bare token is a seat name, exactly as before');
});

// A seat may legitimately be NAMED for a verb, and the one-token rule is what
// makes that unambiguous rather than a collision to be resolved by precedence.
test('VERBS: a lone verb-spelled token is still a seat name, not a verb', () => {
  const { envelopeFor } = require('../scripts/clodex-voice-tap.js');
  for (const word of ['tap', 'select', 'mode', 'speech']) {
    assert.deepStrictEqual(envelopeFor([word]),
      { type: 'voice-tap', from: 'voice-tap', target: word },
      `"${word}" alone addresses a seat of that name`);
  }
});

test('VERBS: the explicit verb forms build the envelopes the socket decodes', () => {
  const { envelopeFor } = require('../scripts/clodex-voice-tap.js');
  assert.deepStrictEqual(envelopeFor(['tap', 'wirescope']),
    { type: 'voice-tap', from: 'voice-tap', target: 'wirescope' });
  assert.deepStrictEqual(envelopeFor(['select', 'wirescope']),
    { type: 'voice-select', from: 'voice-tap', target: 'wirescope' });
  assert.deepStrictEqual(envelopeFor(['mode', 'tap']),
    { type: 'voice-mode', from: 'voice-tap', mode: 'tap' });
  assert.deepStrictEqual(envelopeFor(['mode', 'hold']),
    { type: 'voice-mode', from: 'voice-tap', mode: 'hold' });
  assert.deepStrictEqual(envelopeFor(['speech', 'on']),
    { type: 'voice-speech', from: 'voice-tap', state: 'on' });
  assert.deepStrictEqual(envelopeFor(['speech', 'off']),
    { type: 'voice-speech', from: 'voice-tap', state: 'off' });
});

// Rejected at the script, so a typo'd shortcut fails where he can see it rather
// than sending an envelope the app declines into a log he never reads.
test('VERBS: an unknown verb and a bad mode are refused, not sent', () => {
  const { envelopeFor } = require('../scripts/clodex-voice-tap.js');
  assert.match(envelopeFor(['reboot', 'now']).error, /unknown verb "reboot"/);
  assert.match(envelopeFor(['speech', 'loud']).error, /on\|off/);
  assert.match(envelopeFor(['mode', 'loud']).error, /tap\|hold/);
  // No envelope is built on either path — an `error` key and nothing to send.
  assert.strictEqual(envelopeFor(['mode', 'loud']).type, undefined);
});

// `reboot` kills every session and is reachable from a stray phrase, so its
// ABSENCE is the safety property — a hook left for it is the thing to catch.
test('VERBS: no reboot verb exists anywhere on the voice path', () => {
  const fs = require('fs');
  const path = require('path');
  const script = fs.readFileSync(
    path.join(__dirname, '..', 'scripts', 'clodex-voice-tap.js'), 'utf-8');
  assert.doesNotMatch(script, /reboot/i, 'the sender must not know the word');
  const handler = fs.readFileSync(
    path.join(__dirname, '..', 'session-manager.js'), 'utf-8');
  assert.doesNotMatch(handler, /voice-reboot/, 'and no socket arm decodes one');
});

test('SELECT: selects the named seat, then arms it, in that order', () => {
  const m = mk();
  const { b } = twoWindows(m);
  m.noteAppFocused(true);
  assert.deepStrictEqual(m.voiceSelect('B'), { ok: true, name: 'B' });
  // THE WHOLE FRAME SEQUENCE, and the order is the assertion: the switch has to
  // reach the window before the tap, or the recorder lights on a tab that is
  // not yet on screen — which is the entire bug this verb fixes.
  //
  // The raise sits INSIDE the sequence, between the retarget and the tap: with
  // Clodex frontmost this fixture once asserted no raise at all, which pinned
  // the very no-op that made select useless across windows.
  assert.deepStrictEqual(b.sent,
    [['app-focused', true], ['request-switch-session', 'B'],
      ['mic-target', 'B'], ['#show'], ['#focus'], ['voice-tap', 'B', false]]);
});

// THE CASE THE VERB EXISTS FOR, and it was covered nowhere: he is looking at
// Clodex WINDOW A and names a seat in window B. App focus is TRUE — Clodex is
// not buried, so the tap's own gate declines to raise — and without an explicit
// intent the tab switches inside a HIDDEN window, the microphone follows it,
// and he dictates at a screen showing A while the audio goes to B.
test('SELECT: raises the target window even when Clodex is ALREADY frontmost', () => {
  const m = mk();
  const { a, b } = twoWindows(m);
  reportFrom(m, a, 'A');
  assert.strictEqual(m.appFocused(), true,
    'ENTER: Clodex is frontmost, or this passes for the backgrounded reason below');

  assert.deepStrictEqual(m.voiceSelect('B'), { ok: true, name: 'B' });
  assert.deepStrictEqual(b.raised, ['show', 'focus'],
    'the target window came forward across the workspace boundary');
  assert.deepStrictEqual(a.raised, [], 'and the window he was looking at was not disturbed');
});

// The other half of the pair: a BARE TAP must keep declining to raise while
// Clodex is frontmost. The raise is select's intent, not a new default — a tap
// that stole focus between windows would interrupt whatever he is typing.
test('SELECT: the raise is select\'s intent only — a bare tap still does not steal focus', () => {
  const m = mk();
  const { a, b } = twoWindows(m);
  reportFrom(m, a, 'A');
  assert.deepStrictEqual(m.voiceTap('B'), { ok: true, name: 'B' });
  assert.deepStrictEqual(b.raised, [], 'the tap did not pull window B forward');
});

test('SELECT: a select with the whole APP backgrounded raises that seat\'s window', () => {
  // Distinct from the frontmost cross-window case above: here Clodex itself is
  // buried behind another application, which is the raise voiceTap already had.
  const m = mk();
  const { a, b } = twoWindows(m);
  m.noteAppFocused(false);
  assert.deepStrictEqual(m.voiceSelect('B'), { ok: true, name: 'B' });
  assert.deepStrictEqual(b.raised, ['show', 'focus'], 'B\'s window came forward');
  assert.deepStrictEqual(b.sent,
    [['request-switch-session', 'B'], ['mic-target', 'B'], ['#show'], ['#focus'],
      ['voice-tap', 'B', false]]);
  // voiceTap's raise, REUSED rather than duplicated: A's window is untouched, which
  // a second raise mechanism firing on the manager's own idea of "the window"
  // would not be.
  assert.deepStrictEqual(a.raised, [], 'no other window was disturbed');
});

// THE SAFETY PROPERTY. An unmatched name must not fall back to the focused
// seat: that has him dictating into the wrong agent BELIEVING he switched,
// which is worse than nothing happening at all.
test('SELECT: an unmatched name arms NOTHING and selects NOTHING', () => {
  const m = mk();
  const { a, b } = twoWindows(m);
  reportFrom(m, a, 'A');
  const before = { a: [...a.sent], b: [...b.sent] };
  const r = m.voiceSelect('ghost');
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /no live session "ghost"/);
  // Nothing moved: not the microphone, not a window, not one frame on either
  // window. Comparing the WHOLE list against its own prior value is what makes
  // this a no-op assertion rather than an absence-of-one-thing assertion.
  assert.deepStrictEqual(a.sent, before.a, 'the focused seat was NOT selected or armed');
  assert.deepStrictEqual(b.sent, before.b);
  assert.deepStrictEqual(a.raised, []);
  assert.deepStrictEqual(b.raised, []);
  assert.strictEqual(m.micTarget(), 'A', 'the microphone did not move');
});

// MUTATION CHECK on the rule above: if `select` ever grew the tap's absent-target
// fallback, the test above would still pass for a DIFFERENT reason unless the
// fallback path itself is pinned as unreachable from a NAMED select. A named
// select and a bare tap must not resolve the same way.
test('SELECT: the fallback that serves a bare tap is unreachable from a named select', () => {
  const m = mk();
  const { a } = twoWindows(m);
  reportFrom(m, a, 'A');
  // The focused seat IS live and armable — so a fallback would succeed here.
  // That is what makes the decline meaningful rather than incidental.
  assert.deepStrictEqual(m.voiceTap(), { ok: true, name: 'A' }, 'the fallback works when nothing is named');
  const armed = [...a.sent];
  assert.strictEqual(m.voiceSelect('ghost').ok, false);
  assert.deepStrictEqual(a.sent, armed, 'a named select did not reach that same fallback');
});

// THE HOLE THE UNMATCHED-NAME PIN DID NOT COVER. An empty string is a PRESENT
// argument, so it never reaches the "unmatched" path: it is falsy, and the
// route's absent-target fallback is the tap's rule, which resolves it to the
// FOCUSED seat — selected, given the microphone and armed while he believes he
// switched. It arrives from `select "$SEAT"` with SEAT unset, not from
// anything exotic.
test('SELECT: an EMPTY name arms NOTHING and selects NOTHING', () => {
  const m = mk();
  const { a, b } = twoWindows(m);
  reportFrom(m, a, 'A');
  const before = { a: [...a.sent], b: [...b.sent] };

  for (const empty of ['', '   ', '\t']) {
    const r = m.voiceSelect(empty);
    assert.strictEqual(r.ok, false, `${JSON.stringify(empty)} is refused`);
    assert.match(r.error, /select needs a seat name/);
  }
  // Same whole-list no-op shape the unmatched-name pin uses: nothing moved on
  // either window, and the microphone stayed where it was.
  assert.deepStrictEqual(a.sent, before.a, 'the focused seat was NOT selected or armed');
  assert.deepStrictEqual(b.sent, before.b);
  assert.deepStrictEqual(a.raised, []);
  assert.deepStrictEqual(b.raised, []);
  assert.strictEqual(m.micTarget(), 'A', 'the microphone did not move');
});

// The manager holds the line even when the script is bypassed — the socket is
// the trust boundary, and the design note anticipates a second front-end onto
// these verbs.
test('SELECT: the socket arm cannot smuggle an empty name past the manager', () => {
  const m = mk();
  const { a, b } = twoWindows(m);
  reportFrom(m, a, 'A');
  const before = [...a.sent];
  m._onIncoming('courier', { type: 'voice-select', from: 'voice-tap', target: '' });
  assert.deepStrictEqual(a.sent, before, 'nothing reached the focused seat');
  assert.deepStrictEqual(b.sent.filter((f) => f[0] === 'voice-tap'), [], 'and nothing armed');
});

// And the script refuses it before an envelope exists, so the shortcut fails
// where he can see it rather than sending something the app silently drops.
test('SELECT: the script refuses an empty seat name', () => {
  const { envelopeFor } = require('../scripts/clodex-voice-tap.js');
  assert.match(envelopeFor(['select', '']).error, /select needs a seat name/);
  assert.match(envelopeFor(['select', '  ']).error, /select needs a seat name/);
  assert.strictEqual(envelopeFor(['select', '']).type, undefined, 'no envelope is built');
});

test('SELECT: the socket arm dispatches voice-select', () => {
  const m = mk();
  const { b } = twoWindows(m);
  m.noteAppFocused(true);
  m._onIncoming('courier', { type: 'voice-select', from: 'voice-tap', target: 'B' });
  // Raise included: the socket arm is the real entry point, so it must show the
  // same window-forward behaviour the direct call does.
  assert.deepStrictEqual(b.sent,
    [['app-focused', true], ['request-switch-session', 'B'],
      ['mic-target', 'B'], ['#show'], ['#focus'], ['voice-tap', 'B', false]]);
});

// `mode` no longer touches a pty: it writes the CLI's settings file. So this
// harness seams the WRITER and asserts the call that reaches it, while the seat
// below keeps a recording pty so the no-injection claim is made against real
// bytes rather than against the absence of a call.
//
// The writer's own behaviour — sibling survival, unrelated keys, atomicity,
// corrupt files — is pinned in test/voice-settings.test.js against a temp dir,
// which is where that module is testable without a manager at all.
function mkMode({ writeResult = null } = {}) {
  const calls = [];
  const logs = [];
  const m = mk({
    writeVoiceMode: (mode) => {
      calls.push(mode);
      return writeResult || { ok: true, mode, file: '/tmp/fake/settings.json' };
    },
    log: {
      info: (...a) => logs.push(['info', a.join(' ')]),
      warn: (...a) => logs.push(['warn', a.join(' ')]),
      error: () => {}, debug: () => {},
    },
  });
  m._broadcast = () => {};
  return { m, calls, logs };
}

// A claude seat with a recording pty, so "nothing was typed" is an assertion
// about bytes and not about a method nobody called.
function micSeat(m, name, win) {
  const writes = [];
  m.sessions.set(name, {
    name, agentType: 'claude', workspaceId: win.ws, _dead: false,
    _bootReadySeen: true,
    lastUserInputTs: 0, lastUserSubmitTs: 0,
    pty: { write: (b) => writes.push(b) },
  });
  return writes;
}

function settle(ms = 250) { return new Promise((r) => setTimeout(r, ms)); }

test('MODE: writes the mode through the settings writer', () => {
  const { m, calls } = mkMode();
  assert.deepStrictEqual(m.voiceMode('hold'), { ok: true, mode: 'hold' });
  assert.deepStrictEqual(calls, ['hold']);
});

test('MODE: tap and hold both reach the writer verbatim', () => {
  const { m, calls } = mkMode();
  m.voiceMode('tap');
  m.voiceMode('hold');
  assert.deepStrictEqual(calls, ['tap', 'hold']);
});

test('MODE: takes NO seat — no mic holder, no window, no live session', () => {
  const { m, calls } = mkMode();
  // Exactly the state the OLD mechanism declined in: nothing focused or tapped.
  assert.strictEqual(m.micTarget(), null,
    'ENTER: no seat holds the microphone, or the unconditional claim is vacuous');
  assert.strictEqual(m.sessions.size, 0, 'ENTER: and no session exists at all');
  assert.deepStrictEqual(m.voiceMode('hold'), { ok: true, mode: 'hold' });
  assert.deepStrictEqual(calls, ['hold'], 'the box-wide setting changed anyway');
});

test('MODE: nothing is typed into the seat holding the microphone', async () => {
  const { m, calls } = mkMode();
  const win = fakeWin(); win.ws = 'ws1';
  m.registerWindow('ws1', win);
  const writes = micSeat(m, 'A', win);
  reportFrom(m, win, 'A');
  // ENTER: a live seat DOES hold the mic, so an injection had a destination.
  // Without this the empty-writes assertion is true of an empty fixture.
  assert.strictEqual(m.micTarget(), 'A');
  assert.ok(m.sessions.get('A') && !m.sessions.get('A')._dead);

  m.voiceMode('hold');
  await settle();
  assert.deepStrictEqual(writes, [], 'no composer, no queue, no park divert');
  assert.deepStrictEqual(calls, ['hold'], 'it went to the file instead');
});

test('MODE: an invalid mode is declined by the writer and reported', () => {
  // The enum lives in the writer, so the manager must PASS THROUGH its refusal
  // rather than keep a second copy of the rule that could drift from it.
  const { m } = mkMode({ writeResult: { ok: false, error: 'unknown voice mode "loud" (use tap|hold)' } });
  const r = m.voiceMode('loud');
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /unknown voice mode "loud"/);
});

test('MODE: a failed write is returned and logged, never thrown', () => {
  const { m, logs } = mkMode({ writeResult: { ok: false, error: 'EACCES: permission denied' } });
  const r = m.voiceMode('hold');
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /EACCES/);
  assert.ok(logs.some(([lvl, msg]) => lvl === 'warn' && /EACCES/.test(msg)),
    'the failure is logged rather than silent');
});

test('MODE: the socket arm dispatches voice-mode and takes the mode only as a string', async () => {
  const { m, calls } = mkMode();
  const win = fakeWin(); win.ws = 'ws1';
  m.registerWindow('ws1', win);
  micSeat(m, 'A', win);
  reportFrom(m, win, 'A');
  m._onIncoming('courier', { type: 'voice-mode', from: 'voice-tap', mode: 'hold' });
  await settle();
  assert.deepStrictEqual(calls, ['hold']);
  // Delivered to NO transcript: a box-wide request arriving on an agent's
  // socket is not a message to that agent.
  assert.deepStrictEqual(win.sent.filter((f) => f[0] === 'agent-message'), []);

  // A non-string mode is nulled at the arm, so it reaches the writer as a value
  // the enum rejects rather than being interpolated into a file as an object.
  m._onIncoming('courier', { type: 'voice-mode', from: 'voice-tap', mode: { evil: 1 } });
  await settle();
  assert.deepStrictEqual(calls, ['hold', null]);
});

// The one hop nothing else covers, extended to the new verbs: the script builds
// these envelopes and the manager dispatches on them, in two files that never
// import each other. Spelling either side differently leaves both green in
// isolation and the phrase silently dead.
test('VERBS: script and socket agree on the new envelope types', () => {
  const fs = require('fs');
  const path = require('path');
  const script = fs.readFileSync(
    path.join(__dirname, '..', 'scripts', 'clodex-voice-tap.js'), 'utf-8');
  const handler = fs.readFileSync(
    path.join(__dirname, '..', 'session-manager.js'), 'utf-8');
  assert.match(script, /type: 'voice-select'/);
  assert.match(handler, /mtype === 'voice-select'/);
  assert.match(script, /type: 'voice-mode'/);
  assert.match(handler, /mtype === 'voice-mode'/);
});

// ------------------------------------------------------------- the speech verb

// A manager whose settings store is REAL enough to be written and read back,
// because the claim is that the verb changes what the box will do — not that it
// called a setter. `set` merges like the real store's, so a write of one key
// must leave the others alone.
function mkSpeech({ speakReplies = false } = {}) {
  let cur = { speakReplies, speakVoice: 'Daniel', speakRate: 210 };
  const sets = [];
  const store = {
    get: () => ({ ...cur }),
    set: (partial) => {
      sets.push(partial);
      cur = { ...cur, ...partial };
      return { ...cur };
    },
  };
  const m = mk({ getUiSettings: () => store });
  m._broadcast = () => {};
  return { m, store, sets, read: () => ({ ...cur }) };
}

test('SPEECH: `on` sets the store value and `off` clears it', () => {
  const h = mkSpeech();
  assert.strictEqual(h.read().speakReplies, false, 'ENTER: starts off, or `on` proves nothing');

  assert.deepStrictEqual(h.m.voiceSpeech('on'), { ok: true, state: 'on', speakReplies: true });
  assert.strictEqual(h.read().speakReplies, true, 'the STORE changed, not just the return value');

  assert.deepStrictEqual(h.m.voiceSpeech('off'), { ok: true, state: 'off', speakReplies: false });
  assert.strictEqual(h.read().speakReplies, false);
});

// The gate that decides whether a turn is spoken reads the store at every turn
// end, so "the setting changed" and "the box will now speak" are the same claim
// — asserted through the REAL gate rather than by re-reading the value written.
test('SPEECH: the speaking gate follows the store, which is what makes the verb real', () => {
  const h = mkSpeech();
  const cfgOff = h.store.get();
  assert.strictEqual(cfgOff.speakReplies !== true, true,
    'ENTER: the gate\'s own predicate says silent before the flip');
  h.m.voiceSpeech('on');
  const cfgOn = h.store.get();
  assert.strictEqual(cfgOn.speakReplies !== true, false,
    'and says speak after it — the same expression _maybeSpeak evaluates');
});

// BOX-WIDE, not per-seat. The verb must not grow a seat scope: there is no
// per-seat speech flag for it to mean anything against.
test('SPEECH: takes no seat name and does not consult the microphone holder', () => {
  const h = mkSpeech();
  const win = fakeWin(); win.ws = 'ws1';
  h.m.registerWindow('ws1', win);
  h.m.sessions.set('A', { name: 'A', agentType: 'claude', workspaceId: 'ws1', _dead: false });
  reportFrom(h.m, win, 'A');
  assert.strictEqual(h.m.micTarget(), 'A', 'ENTER: a seat DOES hold the mic, so ignoring it is a choice');

  // WATCH THE READ, not the arity. `voiceSpeech.length` is 1 even for
  // `(state, seat = null)` — a default parameter does not count — so an arity
  // pin passes for exactly the per-seat mutant it was meant to forbid.
  // Observing whether micTarget is CONSULTED is the property itself.
  let micReads = 0;
  const realMicTarget = h.m.micTarget.bind(h.m);
  h.m.micTarget = () => { micReads++; return realMicTarget(); };
  Object.defineProperty(h.m, '_micTarget', {
    get() { micReads++; return 'A'; },
    set() {},
    configurable: true,
  });

  // Called the way the SOCKET ARM calls it — state only. That is the invocation
  // a per-seat implementation would have to serve by falling back to the mic
  // holder, so it is the one that exposes the read. Passing a seat explicitly
  // would short-circuit that fallback and hide it.
  assert.deepStrictEqual(h.m.voiceSpeech('on'), { ok: true, state: 'on', speakReplies: true });
  assert.strictEqual(micReads, 0, 'the microphone holder was never read — this verb is box-wide');

  // And a seat passed anyway changes nothing, which is the other half.
  assert.deepStrictEqual(h.m.voiceSpeech('off', 'A'), { ok: true, state: 'off', speakReplies: false });
  // Box-wide writes, with no seat key anywhere in either partial.
  assert.deepStrictEqual(h.sets, [{ speakReplies: true }, { speakReplies: false }]);
  assert.strictEqual(realMicTarget(), 'A', 'and the microphone did not move');
});

// A TOGGLE IS FORBIDDEN: he cannot see the current state from across the room,
// so repeating a mis-heard phrase must not flip it back. Idempotence IS the
// safety property here.
test('SPEECH: repeating the same state is idempotent, never a toggle', () => {
  const h = mkSpeech();
  h.m.voiceSpeech('on');
  h.m.voiceSpeech('on');
  h.m.voiceSpeech('on');
  assert.strictEqual(h.read().speakReplies, true, 'still on after saying it three times');
  h.m.voiceSpeech('off');
  h.m.voiceSpeech('off');
  assert.strictEqual(h.read().speakReplies, false, 'and still off');
});

test('SPEECH: a state that is neither on nor off writes NOTHING', () => {
  const h = mkSpeech({ speakReplies: true });
  for (const bad of ['loud', 'toggle', '', null, undefined, true]) {
    const r = h.m.voiceSpeech(bad);
    assert.strictEqual(r.ok, false, `${String(bad)} is refused`);
    assert.match(r.error, /unknown speech state/);
  }
  // The store was never touched: a rejected state must not fall through to a
  // write, which is what would make a mis-heard word silence him.
  assert.deepStrictEqual(h.sets, []);
  assert.strictEqual(h.read().speakReplies, true, 'the existing value survived every refusal');
});

// The write must not clobber the sibling keys — the popover reads voice and rate
// from the same object, and a full-object write would reset them.
test('SPEECH: the write is a partial and leaves the other speech settings alone', () => {
  const h = mkSpeech();
  h.m.voiceSpeech('on');
  assert.deepStrictEqual(h.sets, [{ speakReplies: true }], 'ONE key in the partial');
  assert.deepStrictEqual(h.read(), { speakReplies: true, speakVoice: 'Daniel', speakRate: 210 });
});

test('SPEECH: the socket arm dispatches voice-speech and takes the state only as a string', () => {
  const h = mkSpeech();
  h.m._onIncoming('courier', { type: 'voice-speech', from: 'voice-tap', state: 'on' });
  assert.strictEqual(h.read().speakReplies, true);
  // A non-string state reaches the verb as null and is refused, so a malformed
  // envelope cannot write anything.
  h.m._onIncoming('courier', { type: 'voice-speech', from: 'voice-tap', state: { on: true } });
  assert.strictEqual(h.read().speakReplies, true, 'unchanged by the malformed envelope');
  assert.deepStrictEqual(h.sets, [{ speakReplies: true }], 'and no second write happened');
});

test('SPEECH: script and socket agree on the envelope type', () => {
  const fs = require('fs');
  const path = require('path');
  const script = fs.readFileSync(
    path.join(__dirname, '..', 'scripts', 'clodex-voice-tap.js'), 'utf-8');
  const handler = fs.readFileSync(
    path.join(__dirname, '..', 'session-manager.js'), 'utf-8');
  assert.match(script, /type: 'voice-speech'/);
  assert.match(handler, /mtype === 'voice-speech'/);
  // NOT injected: this is Clodex's own setting, and a slash command here would
  // be writing a file the running CLI disagrees with — the exact failure `mode`
  // exists to avoid, in reverse.
  const body = /voiceSpeech\(state\)\s*\{[\s\S]*?\n    \}/.exec(handler);
  assert.ok(body, 'ENTER: the method body was located, or the assertions below read nothing');
  assert.doesNotMatch(body[0], /_injectText|pty\.write/,
    'speech writes the settings store, never the pty');
});

// THE COMPATIBILITY PROPERTY, re-pinned with three verbs present. His daily
// shortcut invokes this script by path with zero or one argument; a third verb
// must not have changed those bytes.
test('SPEECH: his legacy invocations are STILL byte-identical with three verbs present', () => {
  const { envelopeFor } = require('../scripts/clodex-voice-tap.js');
  assert.deepStrictEqual(envelopeFor([]),
    { type: 'voice-tap', from: 'voice-tap' },
    'bare: still no target key at all');
  assert.deepStrictEqual(envelopeFor(['wirescope']),
    { type: 'voice-tap', from: 'voice-tap', target: 'wirescope' },
    'named: still a tap of that seat');
  // The one-token rule now carries four verb words, and a seat may be named for
  // any of them. `speech` is the newest and the one a later verb is most likely
  // to collide with.
  assert.deepStrictEqual(envelopeFor(['speech']),
    { type: 'voice-tap', from: 'voice-tap', target: 'speech' },
    'a seat named `speech` is still addressable by the legacy shape');
});

// ------------------------------------------- the tap works from ANY voice mode

// THE PROPERTY: the spoken tap arms a usable recorder whatever mode the settings
// file was in when it arrived. In `hold` it did not — that arm expects a HELD
// key, so one synthetic keystroke starts a recording and the auto-repeat
// fallback stops it again before he can speak.
//
// Asserted in the two halves the feature is: main sets the mode and says it did,
// and the renderer's watcher waits for the CLI to observe it and then writes.

// A manager whose settings file reads back whatever the fixture says, so the
// mode the tap STARTS from is the variable under test. The real writer is pinned
// in test/voice-settings.test.js and is deliberately not re-asserted here.
function mkTapMode({ mode = 'hold', writeResult = null } = {}) {
  const reads = [];
  const writes = [];
  // The file the fixture stands in for, and a SUCCESSFUL write moves it — the
  // real writer does, and a fixture whose file never changes cannot express the
  // repeat-tap case at all: the second tap would keep reading `hold` and pass
  // for the wrong reason.
  const file = { mode };
  const m = mk({
    readVoiceMode: () => {
      reads.push(file.mode);
      return { file: '/tmp/fake/settings.json', source: 'voice', mode: file.mode, enabled: true, legacy: null, effective: file.mode };
    },
    writeVoiceMode: (next) => {
      writes.push(next);
      const r = writeResult || { ok: true, mode: next, file: '/tmp/fake/settings.json' };
      if (r.ok) file.mode = next;
      return r;
    },
    log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  });
  return { m, reads, writes, file };
}

test('MODE-INDEPENDENT: a tap from HOLD sets the mode to tap and flags the wait', () => {
  const { m, writes } = mkTapMode({ mode: 'hold' });
  const win = seat(m, 'A');
  reportFrom(m, win, 'A');
  assert.deepStrictEqual(m.voiceTap('A'), { ok: true, name: 'A' });
  assert.deepStrictEqual(writes, ['tap'], 'the file was moved off hold');
  // The FLAG on the frame is the load-bearing half: only main knows how recently
  // the mode was written, and it is what tells the renderer it owes the wait.
  assert.deepStrictEqual(win.sent.at(-1), ['voice-tap', 'A', true]);
});

test('MODE-INDEPENDENT: a tap from TAP writes nothing and owes no wait', () => {
  // The common case, and the reason the read is there at all: an unconditional
  // write would put the ~1s settle delay on every tap he makes.
  const { m, writes } = mkTapMode({ mode: 'tap' });
  const win = seat(m, 'A');
  reportFrom(m, win, 'A');
  assert.deepStrictEqual(m.voiceTap('A'), { ok: true, name: 'A' });
  assert.deepStrictEqual(writes, [], 'nothing to change, so the file is untouched');
  assert.deepStrictEqual(win.sent.at(-1), ['voice-tap', 'A', false],
    'no write is settling, so the byte goes out at once');
});

// THE REPEAT IS THE TAP THAT MATTERS. He says the phrase, sees nothing happen,
// and says it again — and that second phrase is the one that has to work. It
// finds the file already on `tap`, so a flag meaning "did I just write" reports
// nothing to wait for and sends the byte under the mode the CLI is STILL on:
// the blink, reproduced on the repeat he made because of the blink.
//
// So the flag answers "may the CLI still be on the old mode", and the age of the
// last write is what decides it.
test('MODE-INDEPENDENT: a SECOND tap inside the settle window still waits', () => {
  const { m, writes, file } = mkTapMode({ mode: 'hold' });
  const win = seat(m, 'A');
  reportFrom(m, win, 'A');

  m.voiceTap('A');
  assert.deepStrictEqual(writes, ['tap'], 'ENTER: the first tap did write the mode');
  assert.deepStrictEqual(win.sent.at(-1), ['voice-tap', 'A', true]);

  // The first tap's write moved the file, so his repeat reads `tap` — which is
  // exactly the state that used to report "nothing to wait for".
  assert.strictEqual(file.mode, 'tap', 'ENTER: the file now reads tap for the repeat');
  assert.deepStrictEqual(m.voiceTap('A'), { ok: true, name: 'A' });
  assert.deepStrictEqual(writes, ['tap'], 'nothing is rewritten — the file is already right');
  assert.deepStrictEqual(win.sent.at(-1), ['voice-tap', 'A', true],
    'but the wait is still owed: the CLI has not observed the write yet');
});

test('MODE-INDEPENDENT: once the window has passed, a tap stops waiting', () => {
  // The other half of the same rule — without this the pin above passes for a
  // flag that is simply always true, which would delay every tap forever.
  const { m, writes } = mkTapMode({ mode: 'hold' });
  const win = seat(m, 'A');
  reportFrom(m, win, 'A');
  m.voiceTap('A');
  assert.deepStrictEqual(win.sent.at(-1), ['voice-tap', 'A', true], 'ENTER: it did wait first');

  // Age the memo past the settle window rather than sleeping through it.
  m._lastVoiceModeWriteAt = Date.now() - 5000;
  m.voiceTap('A');
  assert.deepStrictEqual(writes, ['tap'], 'still no second write');
  assert.deepStrictEqual(win.sent.at(-1), ['voice-tap', 'A', false],
    'the CLI has had time to observe it, so the byte goes out at once');
});

test('MODE-INDEPENDENT: voice switched OFF is turned back on, not read as tap', () => {
  // `effective` folds `enabled: false` to 'off' whatever mode sits beside it, so
  // a file that says `mode: tap, enabled: false` must still be written. Reading
  // `mode` instead of `effective` here would skip the write and leave the tap
  // arming a recorder the CLI has switched off.
  const { m, writes } = mkTapMode({ mode: 'off' });
  const win = seat(m, 'A');
  reportFrom(m, win, 'A');
  m.voiceTap('A');
  assert.deepStrictEqual(writes, ['tap']);
  assert.deepStrictEqual(win.sent.at(-1), ['voice-tap', 'A', true]);
});

test('MODE-INDEPENDENT: a tap that DECLINES changes no box-wide setting', () => {
  // The constraint the spec names: the mode write must not sit on a path that
  // then declines. A tap routing nowhere must not move the mode for the box.
  for (const [label, target, setup] of [
    ['unknown name', 'ghost', () => {}],
    ['dead seat', 'D', (m) => m.sessions.set('D', { name: 'D', agentType: 'claude', workspaceId: 'ws1', _dead: true })],
    ['bash seat', 'S', (m) => m.sessions.set('S', { name: 'S', agentType: null, workspaceId: 'ws1' })],
  ]) {
    const { m, writes } = mkTapMode({ mode: 'hold' });
    const win = seat(m, 'A');
    reportFrom(m, win, 'A');
    setup(m);
    assert.strictEqual(m.voiceTap(target).ok, false, `${label}: declined`);
    assert.deepStrictEqual(writes, [], `${label}: and the settings file is untouched`);
  }
});

test('MODE-INDEPENDENT: an unwritable settings file still routes the tap', () => {
  // The mode it could not change may already suit, so a failed write is reported
  // rather than fatal — but it must not claim a change the renderer would wait
  // on, since nothing is coming.
  const { m, writes } = mkTapMode({ mode: 'hold', writeResult: { ok: false, error: 'EACCES: permission denied' } });
  const win = seat(m, 'A');
  reportFrom(m, win, 'A');
  assert.deepStrictEqual(m.voiceTap('A'), { ok: true, name: 'A' });
  assert.deepStrictEqual(writes, ['tap'], 'ENTER: the write was attempted, or the failure is vacuous');
  assert.deepStrictEqual(win.sent.at(-1), ['voice-tap', 'A', false],
    'no change is claimed, so no wait is owed for something that never happened');
});

// The renderer half. The watcher is what actually writes the byte, and under a
// mode change it must WAIT before doing so — the CLI needs ~1s to observe the
// new mode, measured, and a key written earlier is handled under the old one.
test('MODE-INDEPENDENT: the watcher DEFERS its byte while the mode is settling', async () => {
  const h = tapHarness();
  const pending = h.watcher.externalTap(true);
  // The wait is the assertion: a byte on the wire here is one the CLI handles
  // under the mode it has not yet dropped.
  assert.deepStrictEqual(h.writes, [], 'nothing is written while the CLI is still on the old mode');
  assert.strictEqual(await pending, true);
  assert.deepStrictEqual(h.writes, [' '], 'and the byte follows once it has observed it');
});

test('MODE-INDEPENDENT: with no mode change the byte is written immediately', () => {
  // Synchronously, not merely eventually: this is his every-day tap, and making
  // it wait 1.5s for a change that did not happen is the cost this avoids.
  const h = tapHarness();
  assert.strictEqual(h.watcher.externalTap(false), true);
  assert.deepStrictEqual(h.writes, [' ']);
});

test('MODE-INDEPENDENT: the gates are re-read AFTER the wait, not before it', async () => {
  // 1.5s is long enough for the screen to change under us, so the gates must
  // read it as it is when the key LANDS rather than as it was when the tap
  // arrived. The recorder LIGHTS during the wait here: a byte written then
  // stops the operator mid-sentence, which is the failure this file is shaped
  // around, and gates evaluated up front would not see it.
  const indicator = { text: IDLE_ROW };
  const h = tapHarness({ rows: [{ text: EMPTY_COMPOSER, cursor: true }, indicator] });
  const pending = h.watcher.externalTap(true);
  // ENTER: dark at the moment the tap arrived, or the lit read below is what
  // the gates would have seen anyway and the ordering is untested.
  assert.strictEqual(indicator.text, IDLE_ROW);
  indicator.text = REC_ROW;
  assert.strictEqual(await pending, false, 'the recorder lit while we waited');
  assert.deepStrictEqual(h.writes, [], 'so the byte that would have stopped him is not written');
});

test('MODE-INDEPENDENT: a gate that THROWS after the wait settles, never hangs', async () => {
  // `cursorRow()` is the one gate with no try/catch of its own. A throw there
  // used to leave the promise pending forever, and with it the handler awaiting
  // it. Reached by making the composer read throw only AFTER the wait, which is
  // the only window where this can happen at all.
  const h = tapHarness();
  const pending = h.watcher.externalTap(true);
  h.throwFromCursor();
  assert.strictEqual(await pending, false, 'it declines instead of hanging');
  assert.deepStrictEqual(h.writes, []);
});

test('MODE-INDEPENDENT: a watcher disposed during the wait settles rather than hanging', async () => {
  // Each waiting tap owns a promise a caller is awaiting, so dispose must SETTLE
  // it, not merely drop the timer — an unresolved one leaves that await hanging
  // for the life of the page.
  const h = tapHarness();
  const pending = h.watcher.externalTap(true);
  h.watcher.dispose();
  assert.strictEqual(await pending, false);
  assert.deepStrictEqual(h.writes, [], 'a seat that went away during the wait writes nothing');
});

// THE MEASURED NUMBER ITSELF, as source. Every fixture above injects a short
// settle so the ordering cases stay fast, which means no runtime assertion here
// can see the real one — and the real one is the whole claim: a settings write
// is not visible to a running CLI for ~1066ms, so a key written earlier is
// handled under the OLD mode and the defect returns intact.
//
// Read as source for that reason, not for lack of a better test: the value is a
// property of the vendor's file watcher, and nothing in this repo can exercise
// it without a real CLI on a real pty.
test('MODE-INDEPENDENT: the settle default is above the measured visibility edge', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'renderer', 'voice-submit-watcher.js'), 'utf-8');
  const m = src.match(/const VOICE_TAP_MODE_SETTLE_MS = (\d+);/);
  assert.ok(m, 'the constant is still named and still a literal');
  // 1100 is where NEW was confirmed over three trials, unchanged under load; the
  // first NEW reading was a single trial at 1050. 1000 read OLD three times.
  assert.ok(Number(m[1]) >= 1100,
    `the settle must clear the ~1066ms edge; found ${m[1]}ms`);

  // THE TWO HALVES MUST AGREE. Main decides WHO waits, using its own copy of
  // this number; the watcher performs the wait. Shrink main's alone and it stops
  // arming the wait for taps that still need it — a gap nothing else would
  // catch, since each side is self-consistent and the suite stays green.
  const mainSrc = fs.readFileSync(
    path.join(__dirname, '..', 'session-manager.js'), 'utf-8');
  const mm = mainSrc.match(/const VOICE_MODE_SETTLE_MS = (\d+);/);
  assert.ok(mm, 'main still names its own settle window');
  assert.strictEqual(mm[1], m[1],
    'the window main arms the wait for must equal the wait the watcher performs');
});

// LINK 3 OF THE CHAIN, and the only pin that covers it. The other two halves are
// exercised above with real objects; this one cannot be, so it is pinned as
// source — deliberately, and here is why nothing else reaches it.
//
// The watcher's own mode gate is `tapTrigger` → `getVoiceMode()`, wired in
// renderer.js to `voiceCore.snapshot().state.effective`. That state is refreshed
// by `start()`, a 15s poll, window focus and `choose()` — nothing else. So after
// main sets the mode, the core still reports `hold` for up to 15 seconds, the
// gate declines, and NO BYTE IS WRITTEN AT ALL: the property this ticket exists
// for fails end to end.
//
// Every runtime pin in this file is blind to that. The main-side cases stop at
// the frame, and `tapHarness` injects `getVoiceMode: () => 'tap'`, so a watcher
// under test can never see a stale core. Delete the refresh and all of them stay
// green — which is exactly the failure this pin is here to make loud.
//
// ORDER IS THE ASSERTION, not mere presence: a refresh awaited AFTER the tap
// reads the file the tap already declined on.
test('MODE-INDEPENDENT: the tap handler REFRESHES the mode cache before arming', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf-8');

  // Sliced to the handler so every assertion below is about THIS subscriber and
  // not about some other `refresh()` elsewhere in a 6,000-line file. Both
  // anchors are checked before the slice: a missing end anchor would silently
  // widen the window to the rest of the file.
  const start = src.indexOf('window.api.onVoiceTap(');
  assert.ok(start !== -1, 'ENTER: the tap subscriber is still found by name');
  const end = src.indexOf('createVoiceControl', start);
  assert.ok(end > start, 'ENTER: and the slice is bounded by the line after it');
  const handler = src.slice(start, end);

  // The flag main sends: without a second parameter the handler cannot know a
  // write just happened, and both the refresh and the settle wait are dead.
  assert.match(handler, /onVoiceTap\(async \(\s*name\s*,\s*modeSettling\s*\)/,
    'the handler takes the settling flag main puts on the frame');

  const refreshAt = handler.indexOf('voiceCore.refresh()');
  const tapAt = handler.indexOf('externalTap(modeSettling)');
  assert.ok(refreshAt !== -1,
    'the stale-cache refresh is still here — without it a hold-start tap writes NO byte');
  assert.ok(tapAt !== -1, 'ENTER: and the arm it must precede is still here');
  assert.ok(refreshAt < tapAt,
    'the refresh must come BEFORE the arm, or the gate reads the stale mode anyway');
  // Awaited, not fired and forgotten: an unawaited refresh returns a promise and
  // the arm runs against the cache it was supposed to replace.
  assert.match(handler, /await voiceCore\.refresh\(\)/,
    'and it is awaited, or the arm races the read');
  // UNCONDITIONAL. Gating it on `modeSettling` leaves the stale read this pin
  // exists for: a `/voice tap` typed into a terminal leaves the file already on
  // tap, so main writes nothing and flags no settle, and a core that has not
  // polled in 15s still reports `hold` — the tap declines and writes no byte.
  // The refresh must not sit inside any `if`.
  const guard = handler.slice(0, refreshAt);
  assert.ok(!/\bif\s*\(/.test(guard),
    'the refresh runs on every tap — a condition in front of it reinstates the stale-cache decline');
});

// THE COMPRESSION BAND the deferral opens, and the reason it is not academic.
//
// Tap 1 from `hold` waits out the mode settle. He sees nothing happen — which is
// the whole reason he says the phrase again — so tap 2 arrives just after the
// boundary and lands ~100ms behind tap 1's byte instead of the 1.5s later it was
// spoken. The CLI has not repainted `⏺REC` yet, so the indicator still reads
// DARK and the ensure-on gate would happily write a second byte, which STOPS the
// recording tap 1 just started. Worse than the blink this ticket removes: the
// repeat phrase actively undoes the tap.
test('MODE-INDEPENDENT: a tap in the REPAINT band after a written byte declines', async () => {
  const h = tapHarness();
  // Tap 1 writes, exactly as the deferred arm does when the settle ends.
  assert.strictEqual(await h.watcher.externalTap(true), true);
  assert.deepStrictEqual(h.writes, [' '], 'ENTER: a byte really did go out');

  // Tap 2, inside the repaint window. The screen still shows the pre-byte state
  // — that is the whole trap, and the fixture leaves it dark deliberately.
  h.clock.t += 100;
  assert.strictEqual(h.watcher.externalTap(), false,
    'the screen cannot be trusted yet, so it must not write');
  assert.deepStrictEqual(h.writes, [' '],
    'no second byte — it would STOP the recording the first one started');
});

test('MODE-INDEPENDENT: once the repaint band has passed, a tap writes again', () => {
  // The other half, or the pin above passes for a gate that blocks every tap
  // after the first one forever — which would break the ordinary repeat.
  const h = tapHarness();
  assert.strictEqual(h.watcher.externalTap(), true);
  assert.deepStrictEqual(h.writes, [' ']);

  h.clock.t += 5000;
  assert.strictEqual(h.watcher.externalTap(), true,
    'well past the repaint, the screen is trustworthy again');
  assert.deepStrictEqual(h.writes, [' ', ' ']);
});

// THE OTHER WRITERS. `mode tap` followed by the tap phrase is the exact
// two-phrase workflow this ticket replaces, so the tap that follows it must wait
// for the CLI just as it does after the tap's own write. Leaving one writer
// stamped and the others not is also the asymmetry a later reader "harmonises"
// in whichever direction they guess.
test('MODE-INDEPENDENT: the spoken mode verb arms the settle window too', () => {
  const { m, writes } = mkTapMode({ mode: 'hold' });
  const win = seat(m, 'A');
  reportFrom(m, win, 'A');

  assert.deepStrictEqual(m.voiceMode('tap'), { ok: true, mode: 'tap' });
  assert.deepStrictEqual(writes, ['tap'], 'ENTER: the verb really did write the file');

  // The tap phrase, right behind it. It finds the file already on `tap` and
  // writes nothing — so only the memo can tell it the CLI is still catching up.
  m.voiceTap('A');
  assert.deepStrictEqual(writes, ['tap'], 'no second write — the file is already right');
  assert.deepStrictEqual(win.sent.at(-1), ['voice-tap', 'A', true],
    'but the wait is owed, because the CLI has not observed the verb yet');
});

test('MODE-INDEPENDENT: moving to hold or off arms no wait of its own', () => {
  // The wait exists to let the CLI catch up to TAP, so a move AWAY from tap
  // stamps nothing. Asserted on the memo rather than on a following tap: such a
  // tap finds the file on hold/off and writes `tap` itself, which arms the wait
  // for its OWN write — a true `true` that says nothing about this stamp.
  for (const mode of ['hold', 'off']) {
    const { m } = mkTapMode({ mode: 'tap' });
    assert.strictEqual(m._lastVoiceModeWriteAt, 0, `${mode}: ENTER: nothing stamped yet`);
    m.voiceMode(mode);
    assert.strictEqual(m._lastVoiceModeWriteAt, 0, `${mode}: and still nothing`);
  }
  // The positive control, in the same shape: `tap` DOES stamp, so the two
  // assertions above are about the mode and not about a memo nothing ever sets.
  const { m } = mkTapMode({ mode: 'hold' });
  m.voiceMode('tap');
  assert.ok(m._lastVoiceModeWriteAt > 0, 'tap stamps, so the pair above is not vacuous');
});

// The Preferences row and the bar popover write through the same IPC channel,
// and it must reach the manager rather than the writer directly — picking `tap`
// in the UI and then speaking the tap phrase is the same race as the verb above.
test('MODE-INDEPENDENT: the settings write routes through the manager, not past it', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'ipc-handlers.js'), 'utf-8');
  assert.match(src, /handle\('settings:setVoiceMode',[^)]*\)\s*=>\s*manager\.voiceMode\(mode\)\)/,
    'the UI write goes through the manager, so it stamps the settle memo');
});
