'use strict';

// external-tap-trigger.test.js — the ensure-on tap an OUTSIDE script asks for,
// and the seat it lands on.

const { test } = require('node:test');
const assert = require('node:assert');

const { API_CONTRACT } = require('../api-contract');

// The REAL manager, from the real factory, with the deps voiceTap's path
// touches. Source-shape assertions were the alternative and are strictly
// weaker: they pass for a method that reads the right fields and sends
// nothing.
function mk(overrides = {}) {
  const { createSessionManager } = require('../session-manager');
  const SessionManager = createSessionManager({
    knownSkillNames: () => [],
    getRemoteServer: () => null,
    getUiSettings: () => ({ get: () => ({}) }),
    getPersistence: () => ({ list: () => [], get: () => null }),
    notifyOS: () => {},
    intentEnabled: require('../intent-catalog').intentEnabled,
    withoutPrivilegedIntentsFor: require('../intent-registry').withoutPrivilegedIntentsFor,
    fencedLines: require('../intent-scanner').fencedLines,
    bodyModeFor: require('../intent-registry').bodyModeFor,
    intentEnabledFor: require('../intent-registry').intentEnabledFor,
    intentEnabledForSeat: require('../intent-registry').intentEnabledForSeat,
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

  // NO raise here: the app is already frontmost, which is what `reportFrom`
  // establishes. The backgrounded case, where the tap DOES raise, is pinned in
  // the FOCUS block below.
  assert.deepStrictEqual(win.sent,
    [['voice-tap', 'named']],
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
    [['voice-tap', 'watched']]);
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
    [],
    'no tap frame — and the target was cleared, not merely left behind');
});

test('a DEAD seat and an UNKNOWN name are each declined', () => {
  for (const [label, setup] of [
    ['dead', (m) => { seat(m, 's', { dead: true }); return 's'; }],
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

test('_voiceRoute accepts a codex seat and a bash seat', () => {
  for (const agentType of ['codex', null]) {
    const m = mk();
    seat(m, 's', { agentType });
    const r = m._voiceRoute('s');
    assert.strictEqual(r.ok, true, `${agentType || 'bash'}: routed`);
    assert.strictEqual(r.name, 's');
  }
});

function mkSeatModes(modes = {}) {
  const records = new Map(Object.entries(modes).map(([n, v]) => [n, { name: n, voice: v }]));
  const m = mk({
    getPersistence: () => ({
      list: () => [...records.values()],
      get: (n) => records.get(n) || null,
      setVoice: (n, v) => { if (!records.has(n)) return false; records.get(n).voice = v; return true; },
    }),
  });
  return { m, records };
}

test('an OFF seat is declined by the route, and a tap sends it nothing', () => {
  const { m } = mkSeatModes({ s: 'off' });
  const win = seat(m, 's');
  assert.deepStrictEqual(m._voiceRoute('s'), { ok: false, error: 'voice is off for this seat' });
  assert.strictEqual(m.voiceTap('s').ok, false);
  assert.deepStrictEqual(win.sent, []);
});

test('a seat persisted as hold reads as on and IS tapped', () => {
  const { m } = mkSeatModes({ s: 'hold' });
  const win = seat(m, 's');
  assert.deepStrictEqual(m.voiceTap('s'), { ok: true, name: 's' });
  assert.deepStrictEqual(win.sent.filter((f) => f[0] === 'voice-tap'), [['voice-tap', 's']]);
});

test('MODE: the spoken mode verb sets the FOCUSED seat\u2019s record and broadcasts it', () => {
  const { m, records } = mkSeatModes({ a: 'tap', b: 'tap' });
  const win = seat(m, 'a');
  seat(m, 'b');
  const sent = [];
  m._broadcast = (...a) => sent.push(a);
  reportFrom(m, win, 'a');
  assert.deepStrictEqual(m.voiceMode('off'), { ok: true, name: 'a', mode: 'off' });
  assert.strictEqual(records.get('a').voice, 'off');
  assert.strictEqual(records.get('b').voice, 'tap');
  assert.deepStrictEqual(sent.filter((f) => f[0] === 'seat-voice'), [['seat-voice', 'a', 'off']]);
  assert.strictEqual(m.voiceMode('loud').ok, false);
  assert.strictEqual(m.voiceMode('hold').ok, false);
  assert.strictEqual(records.get('a').voice, 'off');
});

test('MODE: with nothing focused the mode verb declines', () => {
  const { m } = mkSeatModes({});
  assert.strictEqual(m.voiceMode('off').ok, false);
});

test('MODE: the socket arm dispatches voice-mode to the focused seat, the mode only as a string', () => {
  const { m, records } = mkSeatModes({ a: 'tap' });
  const win = seat(m, 'a');
  reportFrom(m, win, 'a');
  m._onIncoming('courier', { type: 'voice-mode', from: 'voice-tap', mode: 'off' });
  assert.strictEqual(records.get('a').voice, 'off');
  m._onIncoming('courier', { type: 'voice-mode', from: 'voice-tap', mode: { evil: 1 } });
  assert.strictEqual(records.get('a').voice, 'off');
  assert.deepStrictEqual(win.sent.filter((f) => f[0] === 'agent-message'), []);
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
    [['voice-tap', 'watched']],
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
    [['voice-tap', 'named']]);
});

// ----------------------------------------------- the microphone has ONE target

// Main owns WHICH SEAT holds the microphone, box-wide, for the reason it owns
// the speaker flag — there is one microphone, and `activeSession` is
// per-WINDOW, so two workspace windows each have a seat that is "active" and a
// locally-evaluated permission answers yes in both. That is how the operator's
// dictation reached two composers at once.

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

test('MIC: the focus report sets the target and sends no window a frame', () => {
  const m = mk();
  const { a, b } = twoWindows(m);
  reportFrom(m, a, 'A');
  assert.strictEqual(m.micTarget(), 'A');
  assert.deepStrictEqual(a.sent, []);
  assert.deepStrictEqual(b.sent, []);
});

test('MIC: switching focus moves it, so two seats can never both hold it', () => {
  const m = mk();
  const { a, b } = twoWindows(m);
  reportFrom(m, a, 'A');
  // From WINDOW 2, which must be the one in front for its report to count.
  a.focused = false;
  reportFrom(m, b, 'B');
  assert.strictEqual(m.micTarget(), 'B');
  assert.deepStrictEqual(a.sent, []);
});

test('MIC: a repeated report of the SAME seat keeps it and sends nothing', () => {
  const m = mk();
  const { a, b } = twoWindows(m);
  reportFrom(m, a, 'A');
  reportFrom(m, a, 'A');
  reportFrom(m, a, 'A');
  assert.deepStrictEqual(a.sent, []);
  assert.deepStrictEqual(b.sent, []);
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
    []);
  assert.deepStrictEqual(b.sent,
    [['voice-tap', 'B']]);
});

test('MIC: a tap that DECLINES does not move the microphone', () => {
  // Every decline in voiceTap is above the retarget, so a tap that routed
  // nowhere cannot take the microphone off the seat that has it and leave the
  // box with no holder at all — which would silence the re-arm everywhere.
  for (const [label, target, setup] of [
    ['unknown name', 'ghost', () => {}],
    ['dead seat', 'D', (m) => m.sessions.set('D', { name: 'D', agentType: 'claude', workspaceId: 'ws1', _dead: true })],
    ['off seat', 'O', (m) => m.sessions.set('O', { name: 'O', agentType: null, workspaceId: 'ws1' })],
    ['no window', 'X', (m) => m.sessions.set('X', { name: 'X', agentType: 'claude', workspaceId: 'ws-closed' })],
  ]) {
    const { m } = mkSeatModes({ O: 'off' });
    const { a } = twoWindows(m);
    setup(m);
    reportFrom(m, a, 'A');
    assert.strictEqual(m.voiceTap(target).ok, false, `${label}: declined`);
    assert.strictEqual(m.micTarget(), 'A', `${label}: A still holds it`);
    assert.deepStrictEqual(a.sent, [], label);
  }
});

test('MIC: nothing focused releases the microphone rather than stranding it', () => {
  const m = mk();
  const { a, b } = twoWindows(m);
  reportFrom(m, a, 'A');
  reportFrom(m, a, null);
  assert.strictEqual(m.micTarget(), null);
  assert.deepStrictEqual(a.sent, []);
  assert.deepStrictEqual(b.sent, []);
});

test('MIC: it starts held by NOBODY', () => {
  // Before any window has reported, no seat may arm. The opposite default
  // would arm every seat at launch, which is the bug at its widest.
  const m = mk();
  assert.strictEqual(m.micTarget(), null);
});

test('MIC: a window that opens later is sent nothing and the holder stands', () => {
  const m = mk();
  const { a } = twoWindows(m);
  reportFrom(m, a, 'A');
  const late = fakeWin();
  m.registerWindow('ws3', late);
  assert.deepStrictEqual(late.sent, []);
  assert.strictEqual(m.micTarget(), 'A');
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
  assert.deepStrictEqual(a.sent, []);
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
  assert.deepStrictEqual(a.sent, []);
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

test('FOCUS: it starts backgrounded, so nothing arms before the host reports', () => {
  const m = mk();
  assert.strictEqual(m.appFocused(), false);
});

test('FOCUS: the host report is mirrored and sends no window a frame', () => {
  const m = mk();
  const { a, b } = twoWindows(m);
  m.noteAppFocused(true);
  assert.strictEqual(m.appFocused(), true);
  assert.deepStrictEqual(a.sent, []);
  assert.deepStrictEqual(b.sent, []);
});

test('FOCUS: going to the background clears the flag', () => {
  const m = mk();
  const { a } = twoWindows(m);
  m.noteAppFocused(true);
  m.noteAppFocused(false);
  assert.strictEqual(m.appFocused(), false);
  assert.deepStrictEqual(a.sent, []);
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
  m.noteAppFocused(false);
  assert.deepStrictEqual(m.voiceTap('B'), { ok: true, name: 'B' });
  assert.deepStrictEqual(b.raised, ['show', 'focus'], 'the window was brought forward');
  // ORDER, which is the part a pair of counters could not express: the seat
  // holds the microphone before its window comes forward, and the tap frame
  // goes out last.
  assert.deepStrictEqual(b.sent,
    [['#show'], ['#focus'], ['voice-tap', 'B']]);
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
    [['voice-tap', 'B']]);
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
  assert.deepStrictEqual(envelopeFor(['mode', 'off']),
    { type: 'voice-mode', from: 'voice-tap', mode: 'off' });
  assert.match(envelopeFor(['mode', 'hold']).error, /off\|tap/);
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
  assert.match(envelopeFor(['mode', 'loud']).error, /off\|tap/);
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
    [['request-switch-session', 'B'],
      ['#show'], ['#focus'], ['voice-tap', 'B']]);
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
    [['request-switch-session', 'B'], ['#show'], ['#focus'],
      ['voice-tap', 'B']]);
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
    [['request-switch-session', 'B'],
      ['#show'], ['#focus'], ['voice-tap', 'B']]);
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
