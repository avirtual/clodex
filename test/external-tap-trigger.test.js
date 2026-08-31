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
  const state = { rows: rows.map((r) => (typeof r === 'string' ? { text: r } : r)), type };
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
} = {}) {
  const writes = [];
  const env = { attention, voiceMode, trigger };
  const watcher = createVoiceSubmitWatcher(fakeTerminal({ rows, type, indicatorUnreadable }), {
    // The external tap is deliberately NOT gated on the hands-free-submit
    // config, so this returns one enabled: a harness that switched it off would
    // pass every silence assertion below for the wrong reason.
    getConfig: () => ({ enabled: true, rearm: true, phrase: 'over and out' }),
    getAttention: () => env.attention,
    getVoiceMode: () => env.voiceMode,
    getTriggerKey: () => env.trigger,
    write: (d) => writes.push(d),
  });
  live.push(watcher);
  return { watcher, writes, env };
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
      ['voice-tap', 'named']],
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
    [['app-focused', true], ['mic-target', 'watched'], ['voice-tap', 'watched']]);
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
    [['app-focused', true], ['mic-target', 'watched'], ['voice-tap', 'watched']],
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
      ['voice-tap', 'named']]);
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
    [['app-focused', true], ['mic-target', 'A'], ['mic-target', 'B'], ['voice-tap', 'B']]);
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
    [['mic-target', 'B'], ['#show'], ['#focus'], ['voice-tap', 'B']]);
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
    [['app-focused', true], ['mic-target', 'B'], ['voice-tap', 'B']]);
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
  assert.deepStrictEqual(win.sent.at(-1), ['voice-tap', 'A']);
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
  // BOTH edges, or the flag sticks: focus without blur never releases, blur
  // without focus never re-arms.
  assert.match(src, /app\.on\('browser-window-focus', reportAppFocus\)/);
  assert.match(src, /app\.on\('browser-window-blur', reportAppFocus\)/);

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

// --------------------------------------------------- t600: select + mode verbs

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
  for (const word of ['tap', 'select', 'mode']) {
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
});

// Rejected at the script, so a typo'd shortcut fails where he can see it rather
// than sending an envelope the app declines into a log he never reads.
test('VERBS: an unknown verb and a bad mode are refused, not sent', () => {
  const { envelopeFor } = require('../scripts/clodex-voice-tap.js');
  assert.match(envelopeFor(['reboot', 'now']).error, /unknown verb "reboot"/);
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
  assert.deepStrictEqual(b.sent,
    [['app-focused', true], ['request-switch-session', 'B'],
      ['mic-target', 'B'], ['voice-tap', 'B']]);
});

test('SELECT: a cross-workspace select raises that seat\'s window', () => {
  // One BrowserWindow per workspace: without the raise the selection happens
  // behind whatever he is looking at and he dictates into an invisible tab.
  const m = mk();
  const { a, b } = twoWindows(m);
  m.noteAppFocused(false);
  assert.deepStrictEqual(m.voiceSelect('B'), { ok: true, name: 'B' });
  assert.deepStrictEqual(b.raised, ['show', 'focus'], 'B\'s window came forward');
  assert.deepStrictEqual(b.sent,
    [['request-switch-session', 'B'], ['mic-target', 'B'], ['#show'], ['#focus'],
      ['voice-tap', 'B']]);
  // t599's raise, REUSED rather than duplicated: A's window is untouched, which
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

test('SELECT: the socket arm dispatches voice-select', () => {
  const m = mk();
  const { b } = twoWindows(m);
  m.noteAppFocused(true);
  m._onIncoming('courier', { type: 'voice-select', from: 'voice-tap', target: 'B' });
  assert.deepStrictEqual(b.sent,
    [['app-focused', true], ['request-switch-session', 'B'],
      ['mic-target', 'B'], ['voice-tap', 'B']]);
});

// A seat with a pty whose writes are recorded, so `mode` can be followed all the
// way to the bytes rather than to a spy on the manager's own method.
function micSeat(m, name, win) {
  const writes = [];
  m.sessions.set(name, {
    name, agentType: 'claude', workspaceId: win.ws, _dead: false,
    _bootReadySeen: true,
    pty: { write: (b) => writes.push(b) },
  });
  return writes;
}

function settle(ms = 250) { return new Promise((r) => setTimeout(r, ms)); }

test('MODE: injects /voice into the MIC HOLDER, not the active session', async () => {
  const m = mk();
  const a = fakeWin(); a.ws = 'ws1';
  const b = fakeWin(); b.ws = 'ws2';
  m.registerWindow('ws1', a);
  m.registerWindow('ws2', b);
  const aWrites = micSeat(m, 'A', a);
  const bWrites = micSeat(m, 'B', b);
  // THE TWO DIFFER, which is the whole point of the fixture: B holds the
  // microphone while A is the seat a window would call active. `activeSession`
  // is per-window and there are two windows, so it cannot answer this.
  reportFrom(m, a, 'A');
  m.voiceTap('B');
  assert.strictEqual(m.micTarget(), 'B');

  assert.deepStrictEqual(m.voiceMode('hold'), { ok: true, name: 'B', mode: 'hold' });
  await settle();
  assert.ok(bWrites.join('').includes('/voice hold'), 'the mic holder got the command');
  assert.deepStrictEqual(aWrites, [], 'the other seat got nothing');
});

test('MODE: the bytes ride the inject queue rather than a raw pty write', async () => {
  const m = mk();
  const win = fakeWin(); win.ws = 'ws1';
  m.registerWindow('ws1', win);
  const writes = micSeat(m, 'A', win);
  reportFrom(m, win, 'A');
  m.voiceMode('tap');
  await settle();
  // The queue's signature, not the manager's: a leading Ctrl-U in its own write
  // and the text in a later one. A raw `pty.write('/voice tap\r')` would be a
  // single chunk with no '\x15' — and would splice a half-typed draft, which is
  // exactly what riding the queue prevents.
  assert.ok(writes.length > 1, 'more than one write — the Ctrl-U is split from the text');
  assert.strictEqual(writes[0], '\x15', 'the queue leads with clear-line');
  assert.ok(writes.join('').includes('/voice tap'));
});

test('MODE: a mode switch DEFERS while he is dictating', async () => {
  const m = mk();
  const win = fakeWin(); win.ws = 'ws1';
  m.registerWindow('ws1', win);
  const writes = micSeat(m, 'A', win);
  reportFrom(m, win, 'A');
  // t593: dictation gets the protection typing has. The Ctrl-U that opens an
  // injection eats a half-SPOKEN draft exactly as it eats a half-typed one, and
  // stranding his draft is t594's problem class.
  m.sessions.get('A').lastVoiceRecordingTs = Date.now();
  m.voiceMode('hold');
  await settle();
  assert.deepStrictEqual(writes, [], 'nothing was written into the live dictation');
});

test('MODE: an unknown mode and an unheld microphone are declined', () => {
  const m = mk();
  const win = fakeWin(); win.ws = 'ws1';
  m.registerWindow('ws1', win);
  micSeat(m, 'A', win);
  // No mic target yet: nothing has focused or tapped.
  assert.match(m.voiceMode('tap').error, /no seat holds the microphone/);
  reportFrom(m, win, 'A');
  assert.match(m.voiceMode('loud').error, /unknown voice mode "loud"/);
  // The mode is validated BEFORE the target is resolved, so a typo cannot
  // reach a live seat at all.
  assert.match(m.voiceMode(null).error, /unknown voice mode/);
});

test('MODE: the socket arm dispatches voice-mode and takes the mode only as a string', async () => {
  const m = mk();
  const win = fakeWin(); win.ws = 'ws1';
  m.registerWindow('ws1', win);
  const writes = micSeat(m, 'A', win);
  reportFrom(m, win, 'A');
  m._onIncoming('courier', { type: 'voice-mode', from: 'voice-tap', mode: 'hold' });
  await settle();
  assert.ok(writes.join('').includes('/voice hold'));
  // Delivered to NO transcript: a box-wide request arriving on an agent's
  // socket is not a message to that agent.
  assert.deepStrictEqual(win.sent.filter((f) => f[0] === 'agent-message'), []);
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
